import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { supabase } from './supabase.js';
import './style.css';

const $=s=>document.querySelector(s);
/* small per-device settings */
const store={get(k){try{return localStorage.getItem('icebuddy.'+k);}catch(e){return null;}},set(k,v){try{localStorage.setItem('icebuddy.'+k,v);}catch(e){}}};
const css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ---------- load data ---------- */
const BASE=import.meta.env.BASE_URL+'data/mn/';
let IDX,BORDERS;
try{
  [IDX,BORDERS]=await Promise.all([fetch(BASE+'lake_index.json').then(r=>r.json()),fetch(BASE+'borders.json').then(r=>r.json())]);
  $('#lbar').style.width='60%';
}catch(e){$('#ltxt').textContent='The lake data did not load. Check your connection and reload.';throw e;}
// Tiles are read straight from the .pmtiles file with range requests, so only what is on screen downloads.
const protocol=new Protocol();maplibregl.addProtocol('pmtiles',protocol.tile);
const TILE_URL='pmtiles://'+new URL(BASE+'lakes.pmtiles',location.href).href;

/* ---------- color scale (one scheme everywhere) ---------- */
const STOPS=[[0,'--ice-0'],[3,'--ice-0'],[5.5,'--ice-1'],[9.5,'--ice-2'],[13,'--ice-3'],[20,'--ice-4']];
let RGB=[];
const hexRgb=h=>{h=h.replace('#','');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16));};
function loadColors(){RGB=STOPS.map(([v,n])=>[v,hexRgb(css(n))]);}
function iceRGB(v){
  if(v<=RGB[0][0])return RGB[0][1];
  for(let i=1;i<RGB.length;i++){if(v<=RGB[i][0]){const [a,ca]=RGB[i-1],[b,cb]=RGB[i];const t=(v-a)/(b-a);return ca.map((c,k)=>Math.round(c+(cb[k]-c)*t));}}
  return RGB[RGB.length-1][1];
}
const iceCSS=v=>`rgb(${iceRGB(v).join(',')})`;
loadColors();

/* ---------- lakes ---------- */
const INDEX=new Map(IDX.lakes.map(r=>[r[0],{id:r[0],name:r[1],county:r[2],center:[r[3],r[4]],bbox:r[5],acres:r[6]}]));
const lakes=new Map();               // lakes we know about this session (reported or selected)
function lakeInfo(id,props){
  if(lakes.has(id))return lakes.get(id);
  const ix=INDEX.get(id);
  const l={id,name:ix?.name||props?.name||'',county:ix?.county||'',acres:ix?.acres??props?.acres??0,center:ix?.center||null,bbox:ix?.bbox||null,geom:null,n:0,avg:null};
  lakes.set(id,l);return l;
}
const label=l=>l.name||'Unnamed lake';
const geomWait=new Map();
function fillBox(l){
  if(!l.bbox){let b=[180,90,-180,-90];for(const p of l.geom)for(const [x,y] of p[0]){b=[Math.min(b[0],x),Math.min(b[1],y),Math.max(b[2],x),Math.max(b[3],y)];}l.bbox=b;}
  if(!l.center)l.center=[(l.bbox[0]+l.bbox[2])/2,(l.bbox[1]+l.bbox[3])/2];
}
/* Outlines come from the database, only for lakes that need them (reported or selected). */
async function loadGeoms(ls){
  const need=ls.filter(l=>!l.geom&&!geomWait.has(l.id));
  for(let i=0;i<need.length;i+=200){
    const part=need.slice(i,i+200);
    const p=supabase.rpc('lake_outlines',{ids:part.map(l=>l.id)}).then(({data,error})=>{
      if(error)throw error;
      const m=new Map(data.map(r=>[r.id,r.geojson]));
      for(const l of part){const g=m.get(l.id);if(g){l.geom=g.type==='Polygon'?[g.coordinates]:g.coordinates;fillBox(l);}}
    }).catch(e=>{console.warn('outlines',e);for(const l of part)geomWait.delete(l.id);});
    for(const l of part)geomWait.set(l.id,p);
  }
  await Promise.all(ls.map(l=>geomWait.get(l.id)));
}
async function loadGeom(l){await loadGeoms([l]);return l.geom;}
let reports=[];
/* Reports from the last 30 days, newest first. */
async function loadReports(){
  const {data,error}=await supabase.from('readings_recent').select('id,lake_id,user_id,inches,snow_inches,ice,note,observed_at,lon,lat,photo_path,display_name')
    .order('observed_at',{ascending:false}).range(0,4999);
  if(error){console.warn('readings',error);toast('Could not load reports. Showing the map without them.');return;}
  const now=Date.now();
  reports=data.map(r=>({id:r.id,lake:r.lake_id,user:r.user_id,lon:r.lon,lat:r.lat,inches:+r.inches,snow:r.snow_inches==null?null:+r.snow_inches,
    ice:r.ice,note:r.note,photo:r.photo_path,by:r.display_name,ageH:Math.max(0,(now-Date.parse(r.observed_at))/3.6e6)}));
}
const recency=h=>Math.exp(-h/96);
function stats(){
  for(const l of lakes.values()){l.n=0;l.avg=null;}
  const by=new Map();for(const r of reports){(by.get(r.lake)||by.set(r.lake,[]).get(r.lake)).push(r);}
  for(const [id,rs] of by){const l=lakeInfo(id);let sw=0,s=0;for(const r of rs){const w=recency(r.ageH);sw+=w;s+=w*r.inches;}
    l.n=rs.length;l.avg=s/sw;l.min=Math.min(...rs.map(r=>r.inches));l.max=Math.max(...rs.map(r=>r.inches));l.newest=Math.min(...rs.map(r=>r.ageH));}
}
stats();
const reported=()=>[...lakes.values()].filter(l=>l.avg!=null);

/* ---------- geometry helpers ---------- */
function inRing(x,y,ring){let c=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [xi,yi]=ring[i],[xj,yj]=ring[j];if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))c=!c;}return c;}
function inLake(l,x,y){if(!l.geom)return false;const b=l.bbox;if(x<b[0]||x>b[2]||y<b[1]||y>b[3])return false;
  for(const poly of l.geom){if(inRing(x,y,poly[0])&&!poly.slice(1).some(h=>inRing(x,y,h)))return true;}return false;}
const fc=f=>({type:'FeatureCollection',features:f});
const dotFC=()=>fc(reported().filter(l=>l.center).map(l=>({type:'Feature',properties:{avg:l.avg},geometry:{type:'Point',coordinates:l.center}})));

/* ---------- map ---------- */
const wide=()=>innerWidth>760;
const MN=[[-97.3,43.45],[-89.45,49.4]];
const map=new maplibregl.Map({container:'map',attributionControl:false,dragRotate:false,pitchWithRotate:false,
  bounds:MN,fitBoundsOptions:{padding:{top:wide()?60:120,bottom:wide()?60:innerHeight*0.53,left:wide()?380:20,right:wide()?260:20}},
  maxBounds:[[-104,41],[-83,52]],minZoom:4.5,maxZoom:15.5,
  style:{version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':css('--land')}}]}});
map.touchZoomRotate.disableRotation();
const HAS=['!=',['feature-state','avg'],null];
const iceExpr=input=>['interpolate',['linear'],input,...STOPS.flatMap(([v,n])=>[v,css(n)])];
/* Smaller lakes join the tiles at each whole zoom step. Fade them in over 0.6 of a zoom level
   instead of letting thousands appear in one frame. ZMIN mirrors zoom_min_acres in regions/mn.json. */
const ZMIN={4:2000,5:800,6:300,7:100,8:40,9:10};
let satellite=false;
function fillOpacity(){
  const has=z=>z<=7.2?0.92:z>=8.4?0.3:0.92+(0.3-0.92)*(z-7.2)/1.2;
  const stops=[5,5.6,6,6.6,7,7.2,7.6,8,8.4,8.6,9,9.6,10];
  const out=['interpolate',['linear'],['zoom']];
  for(const z of stops){const fresh=Number.isInteger(z)&&ZMIN[z-1]?['<',['get','acres'],ZMIN[z-1]]:false;
    out.push(z,['case',HAS,has(z)*(satellite?0.85:1),fresh,0,satellite?0.18:1]);}
  return out;}
const fillColor=()=>['case',HAS,iceExpr(['coalesce',['feature-state','avg'],0]),css('--water')];

map.on('load',()=>{
  // Free public-domain aerial imagery from the USGS National Map (no key, not the newest photos).
  map.addSource('sat',{type:'raster',tileSize:256,maxzoom:16,attribution:'Imagery: USGS The National Map',
    tiles:['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}']});
  map.addLayer({id:'sat',type:'raster',source:'sat',layout:{visibility:'none'},paint:{'raster-fade-duration':150}});
  map.addSource('lakes',{type:'vector',url:TILE_URL,promoteId:'id'});
  map.addSource('borders',{type:'geojson',data:fc(BORDERS.borders.map(c=>({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:c}})))});
  map.addSource('dots',{type:'geojson',data:dotFC()});
  map.addLayer({id:'borders',type:'line',source:'borders',paint:{'line-color':css('--land-line'),'line-width':1.2,'line-dasharray':[3,2]}});
  map.addLayer({id:'water',type:'fill',source:'lakes','source-layer':'lakes',paint:{'fill-color':fillColor(),
    'fill-opacity':fillOpacity()}});
  map.addLayer({id:'water-edge',type:'line',source:'lakes','source-layer':'lakes',minzoom:8,paint:{'line-color':css('--water-edge'),'line-opacity':['interpolate',['linear'],['zoom'],8,0,8.6,1],'line-width':['interpolate',['linear'],['zoom'],8,0.4,13,1.4]}});
  map.addLayer({id:'sel',type:'line',source:'lakes','source-layer':'lakes',filter:['==',['get','id'],''],paint:{'line-color':css('--accent'),'line-width':['interpolate',['linear'],['zoom'],5,2,12,3.5]}});
  map.addLayer({id:'dots',type:'circle',source:'dots',paint:{'circle-color':iceExpr(['get','avg']),'circle-radius':4.5,'circle-stroke-width':1.5,'circle-stroke-color':css('--panel-solid'),
    'circle-opacity':['interpolate',['linear'],['zoom'],6.3,1,7,0],'circle-stroke-opacity':['interpolate',['linear'],['zoom'],6.3,1,7,0]}});
  map.addSource('me',{type:'geojson',data:fc([])});
  map.addLayer({id:'me-acc',type:'fill',source:'me',filter:['==',['geometry-type'],'Polygon'],paint:{'fill-color':'#3b82f6','fill-opacity':0.12}});
  map.addLayer({id:'me',type:'circle',source:'me',filter:['==',['geometry-type'],'Point'],paint:{'circle-color':'#3b82f6','circle-radius':6,'circle-stroke-width':2.5,'circle-stroke-color':'#fff'}});
  setSatellite(store.get('sat')==='on',false);
  syncStates();resize();draw();
  $('#loading').hidden=true;
  mapReady();
});
function setSatellite(on,save=true){
  satellite=on;if(save)store.set('sat',on?'on':'off');
  $('#satBtn').setAttribute('aria-pressed',String(on));$('#satBtn').setAttribute('aria-label',on?'Show plain map':'Show satellite imagery');
  if(!map.getLayer('sat'))return;
  map.setLayoutProperty('sat','visibility',on?'visible':'none');
  map.setPaintProperty('water','fill-opacity',fillOpacity());
  map.setPaintProperty('water-edge','line-color',on?'rgba(255,255,255,.75)':css('--water-edge'));
}
function syncStates(){
  if(!map.getSource('lakes'))return;
  for(const l of lakes.values())map.setFeatureState({source:'lakes',sourceLayer:'lakes',id:l.id},{avg:l.avg});
  map.getSource('dots').setData(dotFC());
}
function restyle(){
  loadColors();if(!map.getLayer('water'))return;
  map.setPaintProperty('bg','background-color',css('--land'));
  map.setPaintProperty('borders','line-color',css('--land-line'));
  map.setPaintProperty('water','fill-color',fillColor());
  map.setPaintProperty('water-edge','line-color',css('--water-edge'));map.setPaintProperty('sel','line-color',css('--accent'));
  map.setPaintProperty('dots','circle-color',iceExpr(['get','avg']));map.setPaintProperty('dots','circle-stroke-color',css('--panel-solid'));
  setSatellite(satellite,false);draw();renderList();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',restyle);
new MutationObserver(restyle).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});

/* ---------- the clipped blend layer ---------- */
const cv=$('#overlay'),ctx=cv.getContext('2d');
const off=document.createElement('canvas'),octx=off.getContext('2d');
let DPR=1,W=0,H=0;
function resize(){DPR=Math.min(2,devicePixelRatio||1);W=map.getContainer().clientWidth;H=map.getContainer().clientHeight;
  cv.width=W*DPR;cv.height=H*DPR;cv.style.width=W+'px';cv.style.height=H+'px';}
map.on('resize',()=>{resize();draw();});
let radiusM=1800;
const ramp=(z,a,b)=>Math.max(0,Math.min(1,(z-a)/(b-a)));
const blendAlpha=z=>ramp(z,7.2,8.4)*(1-0.55*ramp(z,10.4,12.2));
const pinAlpha=z=>ramp(z,9.6,10.6);
const mpp=(lat,z)=>40075016.686*Math.cos(lat*Math.PI/180)/(512*Math.pow(2,z));
let pinsOnScreen=[];
function lakePath(l){const p=new Path2D();
  for(const poly of l.geom)for(const ring of poly){ring.forEach((c,i)=>{const s=map.project(c);i?p.lineTo(s.x,s.y):p.moveTo(s.x,s.y);});p.closePath();}
  return p;}
function draw(){
  if(!W)return;
  const z=map.getZoom();
  ctx.setTransform(DPR,0,0,DPR,0,0);ctx.clearRect(0,0,W,H);
  pinsOnScreen=[];
  const ba=blendAlpha(z),pa=pinAlpha(z),vb=map.getBounds();
  const visible=reported().filter(l=>l.geom&&!(l.bbox[2]<vb.getWest()||l.bbox[0]>vb.getEast()||l.bbox[3]<vb.getSouth()||l.bbox[1]>vb.getNorth()));
  if(ba>0.01){
    for(const l of visible){
      const tl=map.project([l.bbox[0],l.bbox[3]]),br=map.project([l.bbox[2],l.bbox[1]]);
      const x0=Math.max(0,Math.floor(tl.x)),y0=Math.max(0,Math.floor(tl.y)),x1=Math.min(W,Math.ceil(br.x)),y1=Math.min(H,Math.ceil(br.y));
      if(x1-x0<2||y1-y0<2)continue;
      const cell=Math.max(3,Math.min(8,Math.round(Math.sqrt((x1-x0)*(y1-y0)/9000))));
      const gw=Math.ceil((x1-x0)/cell),gh=Math.ceil((y1-y0)/cell);
      const R=radiusM/mpp(l.center[1],z);
      const pts=reports.filter(r=>r.lake===l.id).map(r=>{const s=map.project([r.lon,r.lat]);return [s.x,s.y,r.inches,recency(r.ageH)];})
        .filter(p=>p[0]>x0-3*R&&p[0]<x1+3*R&&p[1]>y0-3*R&&p[1]<y1+3*R);
      off.width=gw;off.height=gh;
      const img=octx.createImageData(gw,gh),d=img.data;
      const inv=1/(R*R),W0=0.06,cut=9*R*R;
      for(let j=0;j<gh;j++){const py=y0+(j+.5)*cell;
        for(let i=0;i<gw;i++){const px=x0+(i+.5)*cell;
          let sw=0,s=0;
          for(let k=0;k<pts.length;k++){const dx=pts[k][0]-px,dy=pts[k][1]-py,dd=dx*dx+dy*dy;if(dd>cut)continue;const w=pts[k][3]*Math.exp(-dd*inv);sw+=w;s+=w*pts[k][2];}
          const v=(s+W0*l.avg)/(sw+W0),c=iceRGB(v),o=(j*gw+i)*4;
          d[o]=c[0];d[o+1]=c[1];d[o+2]=c[2];d[o+3]=Math.round(255*(0.62+0.38*Math.min(1,sw*1.4)));
        }}
      octx.putImageData(img,0,0);
      ctx.save();ctx.clip(lakePath(l),'evenodd');
      ctx.globalAlpha=ba;ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
      ctx.drawImage(off,0,0,gw,gh,x0,y0,gw*cell,gh*cell);
      ctx.restore();
    }
  }
  if(pa>0.01){
    const big=z>=12.2,r=big?11:7;
    ctx.lineWidth=2;ctx.strokeStyle=css('--panel-solid');
    ctx.font='600 10px Inter,system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
    const ids=new Set(visible.map(l=>l.id));
    for(const rp of reports){if(!ids.has(rp.lake))continue;
      const s=map.project([rp.lon,rp.lat]);if(s.x<-20||s.y<-20||s.x>W+20||s.y>H+20)continue;
      ctx.globalAlpha=pa*(0.45+0.55*recency(rp.ageH));
      ctx.beginPath();ctx.arc(s.x,s.y,r+1.5,0,Math.PI*2);ctx.fillStyle='rgba(10,20,28,.45)';ctx.fill();
      ctx.beginPath();ctx.arc(s.x,s.y,r,0,Math.PI*2);ctx.fillStyle=iceCSS(rp.inches);ctx.fill();ctx.stroke();
      if(big){ctx.fillStyle=rp.inches<9.5&&rp.inches>5.5?'#1a1a1a':'#fff';ctx.fillText(rp.inches%1?rp.inches.toFixed(1):rp.inches,s.x,s.y+.5);}
      pinsOnScreen.push([s.x,s.y,rp]);}
    ctx.globalAlpha=1;
  }
  updateMode(z);
  if(popFor)placePop();
}
map.on('render',draw);

function updateMode(z){
  const m=z<7.8?0:z<10.1?1:2;
  $('#modeName').textContent=['Lake averages','Blended readings','Individual readings'][m];
  document.querySelectorAll('#mode .steps i').forEach((e,i)=>e.classList.toggle('on',i<=m));
  $('#zl').textContent='zoom '+z.toFixed(1);
}

/* ---------- list and search ---------- */
let selected=null,query='';
const ago=h=>h<1?'just now':h<24?Math.round(h)+' h ago':Math.round(h/24)+' d ago';
const fmt=v=>(Math.round(v*2)/2).toFixed(1).replace('.0','');
const acresTxt=a=>a>=1000?(a/1000).toFixed(a>=10000?0:1)+'k acres':Math.round(a)+' acres';
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
function search(q){
  q=q.toLowerCase();const out=[];
  for(const l of INDEX.values()){const n=l.name.toLowerCase();const i=n.indexOf(q);
    if(i<0&&!l.county.toLowerCase().startsWith(q))continue;out.push([i===0?0:i>0?1:2,-l.acres,l]);}
  out.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);return out.slice(0,40).map(x=>x[2]);
}
function lakeRow(l,detail){
  const li=el('li','row');li.setAttribute('role','option');li.tabIndex=0;li.dataset.id=l.id;
  li.setAttribute('aria-selected',String(selected===l.id));
  const sw=el('span','sw');sw.style.background=l.avg==null?css('--water'):iceCSS(l.avg);
  const avg=el('span','avg');
  if(l.avg==null)avg.textContent='—';else{avg.textContent=fmt(l.avg);avg.append(el('small',null,'in'));}
  const meta=el('span','meta',l.avg==null?[l.county,acresTxt(l.acres),'no reports yet'].filter(Boolean).join(' · ')
    :`${fmt(l.min)}–${fmt(l.max)} in · ${l.n} reports · ${ago(l.newest)}`);
  const flags=el('span','flags');
  if(l.avg!=null&&l.max-l.min>=8)flags.append(el('span','flag warn','Wide range'));
  if(l.avg!=null&&l.newest>96)flags.append(el('span','flag','Stale'));
  li.append(sw,el('span','nm',label(l)),avg,meta,flags);
  if(detail){
    const d=el('div','detail');
    const acts=el('div','acts');
    const rb=el('button','btn primary','Report ice here');rb.addEventListener('click',ev=>{ev.stopPropagation();openReport(l);});
    const nb=el('button','btn','Notify me');nb.addEventListener('click',ev=>{ev.stopPropagation();openAlert(l);});
    const fb=el('button','btn','Ice calc');fb.title='Estimate how fast the ice will grow';fb.addEventListener('click',ev=>{ev.stopPropagation();openForecast(l);});
    acts.append(rb,nb,fb);d.append(acts);
    const st=(v,k)=>{const e=el('div','stat');e.append(el('b',null,v),el('span',null,k));return e;};
    if(l.avg!=null){d.append(st(fmt(l.min)+' in','Thinnest'),st(fmt(l.max)+' in','Thickest'),st(l.n,'Reports'));
      d.append(el('p',null,`${l.county?l.county+' County · ':''}${Math.round(l.acres).toLocaleString()} acres · DNR lake ${l.id.split(':')[1]}. The average leans toward newer reports. Zoom in to see each reading.`));}
    else d.append(el('p',null,`${l.county?l.county+' County · ':''}${Math.round(l.acres).toLocaleString()} acres. No one has reported ice here in the last 30 days. Be the first: tap “Report ice here”.`));
    li.append(d);
  }
  li.addEventListener('click',()=>selectLake(l.id,true));
  li.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectLake(l.id,true);}});
  return li;
}
function renderList(){
  const ul=$('#list');ul.replaceChildren();
  if(query){
    const hits=search(query);
    $('#count').textContent=hits.length?(hits.length>=40?'Top 40 matches':hits.length+(hits.length===1?' match':' matches')):'No matches';
    if(!hits.length){ul.append(el('li','empty',`No Minnesota lake matches “${query}”. Try part of the name or a county.`));return;}
    for(const ix of hits)ul.append(lakeRow(lakes.get(ix.id)||ix,selected===ix.id));
    return;
  }
  const sortBy=$('#sort').value,stale=l=>l.newest>96;
  const key={thick:l=>-l.avg,thin:l=>l.avg,recent:l=>l.newest,count:l=>-l.n}[sortBy];
  const ls=reported().sort((a,b)=>{
    if(sortBy==='az')return label(a).localeCompare(label(b));
    if(sortBy!=='recent'&&stale(a)!==stale(b))return stale(a)?1:-1;
    return key(a)-key(b);});
  const sel=selected&&lakes.get(selected);
  if(sel&&sel.avg==null){ul.append(el('li','sec','Selected lake'),lakeRow(sel,true),el('li','sec','Lakes with reports'));}
  $('#count').textContent=ls.length+' lakes with reports';
  for(const l of ls)ul.append(lakeRow(l,selected===l.id));
}
async function selectLake(id,fly,props){
  if(fcLakeRef&&fcLakeRef.id!==id)$('#fc').hidden=true;
  selected=id;const l=lakeInfo(id,props);
  map.setFilter('sel',['==',['get','id'],id||'']);
  if(fly){query='';$('#q').value='';}
  renderList();
  await loadGeom(l);
  if(fly&&l.bbox){map.fitBounds([[l.bbox[0],l.bbox[1]],[l.bbox[2],l.bbox[3]]],
    {padding:{top:70,bottom:wide()?70:innerHeight*0.48,left:wide()?390:30,right:wide()?60:30},maxZoom:12,duration:1400,essential:true});
    if(!wide())collapse(true);}
  if(!fly&&!wide()&&$('#panel').classList.contains('collapsed'))collapse(false,false);
  const row=document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);row&&row.scrollIntoView({block:wide()?'nearest':'start',behavior:'smooth'});
}
function clearSel(){selected=null;map.setFilter('sel',['==',['get','id'],'']);renderList();}
let qt;$('#q').addEventListener('input',e=>{clearTimeout(qt);qt=setTimeout(()=>{query=e.target.value.trim();renderList();},120);});
$('#q').addEventListener('keydown',e=>{if(e.key==='Enter'){const f=document.querySelector('.row');f&&selectLake(f.dataset.id,true);}});
$('#sort').addEventListener('change',renderList);

/* panels remember open/closed per device */
function collapse(c,save=true){$('#panel').classList.toggle('collapsed',c);$('#sheetBtn').setAttribute('aria-expanded',String(!c));
  $('#sheetBtn').setAttribute('aria-label',c?'Show lake list':'Hide lake list');$('#sheetBtn').style.transform=c?'rotate(180deg)':'';if(save)store.set('list',c?'closed':'open');}
$('#sheetBtn').addEventListener('click',()=>collapse(!$('#panel').classList.contains('collapsed')));
function section(btn,box,key,openByDefault=true){
  const set=(open,save=true)=>{box.classList.toggle('closed',!open);btn.setAttribute('aria-expanded',String(open));if(save)store.set(key,open?'open':'closed');};
  btn.addEventListener('click',()=>set(box.classList.contains('closed')));
  const saved=store.get(key);set(saved?saved==='open':openByDefault,false);
}
section($('#legendBtn'),$('#legend'),'legend',!matchMedia('(max-width:640px)').matches);
if(store.get('list')==='closed')collapse(true,false);

/* light / dark map */
const MOON='M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',SUN='M12 4V2M12 22v-2M4.9 4.9 3.5 3.5M20.5 20.5l-1.4-1.4M4 12H2M22 12h-2M4.9 19.1l-1.4 1.4M20.5 3.5l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z';
const isDark=()=>{const t=document.documentElement.dataset.theme;return t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;};
function themeIcon(){const d=isDark();$('#themeIcon').setAttribute('d',d?SUN:MOON);$('#theme').setAttribute('aria-label',d?'Switch to light map':'Switch to dark map');}
const savedTheme=store.get('theme');if(savedTheme==='light'||savedTheme==='dark')document.documentElement.dataset.theme=savedTheme;
themeIcon();
$('#theme').addEventListener('click',()=>{const next=isDark()?'light':'dark';document.documentElement.dataset.theme=next;store.set('theme',next);themeIcon();});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',themeIcon);

/* ice growth forecast (Stefan's rule: h = sqrt(h0^2 + a^2 * freezing degree-days)) */
const PRESETS={cold:[4,-2,-8,-5,2,6,9],normal:[16,12,10,14,18,15,11],warm:[28,31,34,36,33,29,26]};
const ALPHA=[0.80,0.60,0.40];   // in per sqrt(F-day): bare windy ice, some snow, deep snow (Ashton's typical lake values)
let fcLakeRef=null,fcSnow=1,fcTemps=PRESETS.normal.slice();
const dayNames=()=>{const out=[],d=new Date();for(let i=1;i<=7;i++){const x=new Date(d);x.setDate(d.getDate()+i);out.push(x.toLocaleDateString(undefined,{weekday:'short'}));}return out;};
function buildDays(){const g=$('#fcDays');g.replaceChildren();dayNames().forEach((n,i)=>{const lab=el('label',null,n);const inp=document.createElement('input');
  inp.type='number';inp.id='fcT'+i;inp.value=fcTemps[i];inp.step='1';inp.min='-40';inp.max='60';inp.setAttribute('aria-label',n+' average temperature °F');
  inp.addEventListener('input',()=>{fcTemps[i]=parseFloat(inp.value);markPreset(null);runForecast();});lab.append(inp);g.append(lab);});}
function markPreset(p){document.querySelectorAll('#fcPreset button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.p===p)));}
function step(h,T,a){if(isNaN(T))return h;if(T<32){const fdd=32-T;return Math.sqrt(h*h+a*a*fdd);}return Math.max(0,h-0.06*(T-32));}
function series(h0,a){const out=[h0];let h=h0;for(const T of fcTemps){h=step(h,T,a);out.push(h);}return out;}
function runForecast(){
  const h0=Math.max(0,parseFloat($('#fcStart').value)||0),a=ALPHA[fcSnow];
  const mid=series(h0,a),lo=series(h0,Math.max(0.2,a-0.15)),hi=series(h0,a+0.15);
  const end=mid[7];$('#fcEnd').textContent=fmt(end)+' in';$('#fcEnd').style.color=iceCSS(end);
  const diff=end-h0;$('#fcEndTxt').replaceChildren();
  $('#fcEndTxt').append(el('span',diff<-0.05?'melt':null,diff>=0.05?`about +${fmt(diff)} in in 7 days`:diff<=-0.05?`about ${fmt(diff)} in in 7 days: thawing`:'little change in 7 days'),
    document.createTextNode(` · likely range ${fmt(lo[7])}–${fmt(hi[7])} in`));
  // chart
  const svg=$('#fcChart'),Wc=340,Hc=150,L=30,Rt=8,T=10,B=24;
  const all=[...lo,...hi],ymax=Math.max(4,Math.ceil((Math.max(...all)+1)/2)*2),ymin=Math.max(0,Math.floor((Math.min(...all)-1)/2)*2);
  const X=i=>L+i*(Wc-L-Rt)/7,Y=v=>T+(Hc-T-B)*(1-(v-ymin)/(ymax-ymin));
  const NS='http://www.w3.org/2000/svg',mk=(t,at)=>{const e=document.createElementNS(NS,t);for(const k in at)e.setAttribute(k,at[k]);return e;};
  svg.replaceChildren();
  const ticks=4;for(let k=0;k<=ticks;k++){const v=ymin+(ymax-ymin)*k/ticks,y=Y(v);
    svg.append(mk('line',{x1:L,x2:Wc-Rt,y1:y,y2:y,stroke:css('--rule'),'stroke-width':1}));
    const t=mk('text',{x:L-6,y:y+4,'text-anchor':'end'});t.textContent=fmt(v);svg.append(t);}
  const names=['Now',...dayNames()];names.forEach((n,i)=>{const t=mk('text',{x:X(i),y:Hc-6,'text-anchor':'middle'});t.textContent=n;svg.append(t);});
  const band='M'+hi.map((v,i)=>X(i)+','+Y(v)).join('L')+'L'+lo.map((v,i)=>X(7-i)+','+Y(lo[7-i])).join('L')+'Z';
  svg.append(mk('path',{d:band,fill:css('--accent'),'fill-opacity':0.14}));
  for(const th of [4,8,12])if(th>ymin&&th<ymax){const y=Y(th);svg.append(mk('line',{x1:L,x2:Wc-Rt,y1:y,y2:y,stroke:iceCSS(th-0.01),'stroke-dasharray':'3 3','stroke-width':1}));}
  svg.append(mk('path',{d:'M'+mid.map((v,i)=>X(i)+','+Y(v)).join('L'),fill:'none',stroke:css('--accent'),'stroke-width':2.5,'stroke-linejoin':'round'}));
  mid.forEach((v,i)=>svg.append(mk('circle',{cx:X(i),cy:Y(v),r:i===7?4.5:2.5,fill:iceCSS(v),stroke:css('--panel-solid'),'stroke-width':1.5})));
}
/* National Weather Service forecast (free, no key): average of each day's high and night's low, next 7 days. */
const nwsCache=new Map();
async function nwsTemps(lon,lat){
  const k=lat.toFixed(2)+','+lon.toFixed(2);if(nwsCache.has(k))return nwsCache.get(k);
  const p=(async()=>{
    const pt=await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,{headers:{Accept:'application/geo+json'}}).then(r=>{if(!r.ok)throw 0;return r.json();});
    const fc=await fetch(pt.properties.forecast,{headers:{Accept:'application/geo+json'}}).then(r=>{if(!r.ok)throw 0;return r.json();});
    const byDay=new Map();
    for(const per of fc.properties.periods){
      const t=per.temperatureUnit==='C'?per.temperature*9/5+32:per.temperature;
      // a night period belongs to the day it starts on
      const d=per.startTime.slice(0,10);(byDay.get(d)||byDay.set(d,[]).get(d)).push(t);}
    const out=[],d=new Date();
    for(let i=1;i<=7;i++){const x=new Date(d);x.setDate(d.getDate()+i);
      const key=x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');
      const ts=byDay.get(key);out.push(ts?Math.round(ts.reduce((a,b)=>a+b,0)/ts.length):null);}
    return out;})();
  nwsCache.set(k,p);p.catch(()=>nwsCache.delete(k));return p;
}
let nwsNow=null;
async function loadNws(l){
  const b=$('#fcPreset button[data-p="nws"]');b.disabled=true;b.textContent='Loading…';nwsNow=null;
  try{if(!l.center)await loadGeom(l);const [lon,lat]=l.center;const t=await nwsTemps(lon,lat);
    if(fcLakeRef!==l)return;
    if(t.every(v=>v==null))throw 0;
    nwsNow=t.map((v,i)=>v??fcTemps[i]);b.disabled=false;b.textContent='Weather forecast';
    fcTemps=nwsNow.slice();markPreset('nws');buildDays();runForecast();
    $('#fcSrc').textContent='Temperatures: National Weather Service forecast for this lake. Change any day to try your own.';
  }catch(e){b.textContent='Forecast unavailable';$('#fcSrc').textContent='The weather forecast did not load, so these are typical early-winter temperatures.';}
}
function openForecast(l){
  fcLakeRef=l;$('#fcLake').textContent=label(l)+(l.county?' · '+l.county+' County':'');
  $('#fcStart').value=l.avg!=null?fmt(l.avg):4;
  fcTemps=PRESETS.normal.slice();markPreset('normal');buildDays();runForecast();$('#fc').hidden=false;$('#fcStart').focus();
  loadNws(l);
  if(!wide())collapse(true,false);
}
$('#fcClose').addEventListener('click',()=>{$('#fc').hidden=true;});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#fc').hidden)$('#fc').hidden=true;});
$('#fcStart').addEventListener('input',runForecast);
document.querySelectorAll('#fcSnow button').forEach(b=>b.addEventListener('click',()=>{fcSnow=+b.dataset.v;
  document.querySelectorAll('#fcSnow button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));runForecast();}));
document.querySelectorAll('#fcPreset button').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.p==='nws'&&!nwsNow)return;fcTemps=(b.dataset.p==='nws'?nwsNow:PRESETS[b.dataset.p]).slice();markPreset(b.dataset.p);buildDays();runForecast();}));

/* ---------- map interaction ---------- */
const pop=$('#pop');let popFor=null;
function placePop(){const s=map.project([popFor.lon,popFor.lat]);pop.style.left=s.x+'px';pop.style.top=s.y+'px';}
function showPop(r){popFor=r;pop.replaceChildren();
  const x=el('button','x','×');x.setAttribute('aria-label','Close');x.onclick=hidePop;
  const v=el('div','v',fmt(r.inches)+' in');v.style.color=iceCSS(r.inches);
  const iceTxt={clear:'Clear ice',white:'White / snow ice',mixed:'Clear under white'}[r.ice]||'Ice type not given';
  const snowTxt=r.snow==null?'snow not given':r.snow?fmt(r.snow)+' in snow on top':'no snow';
  const l=el('div','l',`${label(lakeInfo(r.lake))}\n${iceTxt} · ${snowTxt}\nReported ${ago(r.ageH)} by ${r.by||'an IceBuddy user'}`+(r.note?`\n“${r.note}”`:''));l.style.whiteSpace='pre-line';
  pop.append(x,v,l);
  if(r.photo){const url=supabase.storage.from('photos').getPublicUrl(r.photo).data.publicUrl;
    const a=el('a','pphoto');a.href=url;a.target='_blank';a.rel='noopener';const im=new Image();im.src=url;im.alt='Photo of the ice with this report';im.loading='lazy';a.append(im);pop.append(a);}
  if(user&&r.user===user.id){const d=el('button','btn','Delete my reading');d.style.marginTop='8px';d.onclick=()=>deleteReading(r);pop.append(d);}
  pop.hidden=false;placePop();}
function hidePop(){popFor=null;pop.hidden=true;}
let adding=false;
function toast(msg,ms=3200){const t=$('#toast');t.textContent=msg;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>t.hidden=true,ms);}

/* ---------- dialogs ---------- */
document.querySelectorAll('dialog [data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));

/* ---------- sign-in, public name ---------- */
let user=null,profile=null,afterSignIn=null;
function renderAuth(){
  const signed=!!user,nm=profile?.display_name||user?.email||'';
  $('#authBtn').textContent=signed?nm.slice(0,1).toUpperCase():'Sign in';
  $('#authBtn').classList.toggle('avatar',signed);
  $('#authBtn').setAttribute('aria-label',signed?'Your account':'Sign in');
}
function openAuth(why){
  const d=$('#authDlg');
  $('#authOut').hidden=!!user;$('#authIn').hidden=!user;
  $('#authTitle').textContent=why||'Sign in to IceBuddy';
  if(user){$('#authWho').textContent=user.email;$('#acctName').value=profile?.display_name||'';renderAlertList();}
  $('#authMsg').textContent='';if(!d.open)d.showModal();
  if(!user)setTimeout(()=>$('#authEmail').focus(),50);
}
/* Run fn now if signed in, otherwise ask to sign in and run it right after. */
function needUser(why,fn){if(user)return fn();afterSignIn=fn;openAuth(why);}
$('#authBtn').addEventListener('click',()=>openAuth());
$('#authClose').addEventListener('click',()=>$('#authDlg').close());
$('#authForm').addEventListener('submit',async e=>{
  e.preventDefault();const email=$('#authEmail').value.trim();if(!email)return;
  $('#authSend').disabled=true;$('#authMsg').textContent='Sending…';
  const {error}=await supabase.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+import.meta.env.BASE_URL}});
  $('#authSend').disabled=false;
  $('#authMsg').textContent=error?('That did not work: '+error.message):`Check ${email} for a sign-in link. Open it on this device.`;
});
$('#signOut').addEventListener('click',async()=>{await supabase.auth.signOut();$('#authDlg').close();toast('Signed out.');});
const NAME_OK=/^[A-Za-z0-9 ._'-]{2,40}$/;
async function saveName(name,msgEl){
  name=name.trim().replace(/\s+/g,' ');
  if(name&&!NAME_OK.test(name)){msgEl&&(msgEl.textContent='Use 2 to 40 letters, numbers, spaces, or . _ \' -');return false;}
  const {error}=await supabase.from('profiles').upsert({id:user.id,display_name:name||null,asked_name:true});
  if(error){msgEl&&(msgEl.textContent='Could not save: '+error.message);return false;}
  profile={...(profile||{}),display_name:name||null,asked_name:true};renderAuth();await refresh();return true;
}
$('#acctNameSave').addEventListener('click',async()=>{if(await saveName($('#acctName').value,$('#authMsg')))toast('Name saved.');});
$('#nameSave').addEventListener('click',async()=>{if(await saveName($('#nameInput').value,$('#nameMsg')))$('#nameDlg').close();});
$('#nameSkip').addEventListener('click',async()=>{await saveName('',null);$('#nameDlg').close();});
$('#nameDlg').addEventListener('close',()=>{const f=afterSignIn;afterSignIn=null;f&&f();});
async function loadProfile(){
  if(!user){profile=null;return;}
  const {data}=await supabase.from('profiles').select('display_name,asked_name').eq('id',user.id).maybeSingle();
  profile=data||{display_name:null,asked_name:false};
}
supabase.auth.onAuthStateChange((ev,session)=>{
  const was=user?.id;user=session?.user??null;
  setTimeout(async()=>{   // never await Supabase inside this callback
    if(user&&user.id!==was){await loadProfile();renderAuth();
      if($('#authDlg').open)$('#authDlg').close();
      if(!profile.asked_name){$('#nameMsg').textContent='';$('#nameDlg').showModal();return;}
      const f=afterSignIn;afterSignIn=null;f&&f();}
    if(!user){profile=null;renderAuth();}
    if(popFor)showPop(popFor);
  },0);
});

/* ---------- location (asks every time until it's allowed) ---------- */
function locSteps(){
  const ua=navigator.userAgent,ios=/iPhone|iPad|iPod/.test(ua),android=/Android/.test(ua);
  if(ios)return ['Open the <b>Settings</b> app, then <b>Privacy &amp; Security → Location Services</b>. Make sure it is on.',
    'Scroll to <b>Safari Websites</b> and choose <b>While Using the App</b>.',
    'Back in IceBuddy, tap <b>aA</b> in the address bar → <b>Website Settings → Location → Allow</b>, then <b>Try again</b>.'];
  if(android)return ['Tap the <b>lock icon</b> next to the web address (or ⋮ → <b>Settings → Site settings</b>).',
    'Choose <b>Permissions → Location → Allow</b>.',
    'If it is still blocked, open phone <b>Settings → Location</b> and turn it on, then <b>Try again</b>.'];
  return ['Click the <b>lock icon</b> next to the web address.','Set <b>Location</b> to <b>Allow</b>, then <b>Try again</b>.'];
}
let locWaiter=null;
function showLocHelp(denied){
  $('#locWhy').textContent=denied?'Location is blocked for IceBuddy. Phones don’t let a website open their settings for you, so here is where to turn it on:'
    :'IceBuddy needs your location to show where you are and drop a report where you’re standing. It’s only used when you tap a location button.';
  $('#locSteps').innerHTML=denied?locSteps().map(t=>`<li>${t}</li>`).join(''):'';
  if(!$('#locDlg').open)$('#locDlg').showModal();
  return new Promise(res=>{locWaiter=res;});
}
$('#locRetry').addEventListener('click',()=>{$('#locDlg').close();const w=locWaiter;locWaiter=null;w&&w(true);});
$('#locDlg').addEventListener('close',()=>{const w=locWaiter;locWaiter=null;w&&w(false);});
function rawLocate(){
  return new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(p=>res(p.coords),rej,{enableHighAccuracy:true,timeout:20000,maximumAge:5000}));
}
async function locate(){
  if(!navigator.geolocation)throw new Error('This device does not share its location.');
  for(;;){
    let state='prompt';try{state=(await navigator.permissions?.query({name:'geolocation'}))?.state||'prompt';}catch(e){}
    if(state==='denied'){if(!await showLocHelp(true))throw new Error('');continue;}
    try{return await rawLocate();}
    catch(e){
      if(e.code===1){if(!await showLocHelp(true))throw new Error('');continue;}
      throw new Error('Could not get a GPS fix. Step into the open and try again.');
    }
  }
}
function showMe(c){
  map.getSource('me')?.setData(fc([{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[circle(c.longitude,c.latitude,c.accuracy)]}},
    {type:'Feature',properties:{},geometry:{type:'Point',coordinates:[c.longitude,c.latitude]}}]));
}
function circle(lon,lat,m){const pts=[];for(let i=0;i<=48;i++){const a=i/48*2*Math.PI;
  pts.push([lon+m*Math.cos(a)/(111320*Math.cos(lat*Math.PI/180)),lat+m*Math.sin(a)/110540]);}return pts;}
$('#locBtn').addEventListener('click',async()=>{
  try{const c=await locate();showMe(c);map.easeTo({center:[c.longitude,c.latitude],zoom:Math.max(map.getZoom(),13),duration:900});}
  catch(e){e.message&&toast(e.message,4500);}
});

/* ---------- reporting ice ---------- */
let rpLake=null,photoBlob=null;
function openReport(l){
  needUser('Sign in to report ice',()=>{
    rpLake=l||(selected?lakes.get(selected):null)||null;
    $('#rpLake').textContent=rpLake?`On ${label(rpLake)}${rpLake.county?' · '+rpLake.county+' County':''}. Use your GPS spot or pick the spot on the map.`
      :'We’ll find the lake from your GPS spot or where you tap on the map.';
    $('#fc').hidden=true;$('#rp').hidden=false;if(!wide())collapse(true,false);
  });
}
function closeReport(){$('#rp').hidden=true;setAdding(false);}
$('#reportBtn').addEventListener('click',()=>openReport(null));
$('#rpClose').addEventListener('click',closeReport);
/* Photos are shrunk on the phone (longest side 1280 px, JPEG) to about 150 KB before upload. */
async function shrinkPhoto(file){
  const bmp=await createImageBitmap(file,{imageOrientation:'from-image'}).catch(()=>null);
  if(!bmp)throw new Error('That photo could not be read. Try a JPEG or PNG.');
  for(const [max,q] of [[1280,0.72],[1024,0.62],[800,0.55]]){
    const k=Math.min(1,max/Math.max(bmp.width,bmp.height)),w=Math.round(bmp.width*k),h=Math.round(bmp.height*k);
    const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(bmp,0,0,w,h);
    const b=await new Promise(r=>c.toBlob(r,'image/jpeg',q));
    if(b&&b.size<=380000)return b;
  }
  throw new Error('That photo is too large even after shrinking.');
}
$('#addPhoto').addEventListener('change',async e=>{
  const f=e.target.files?.[0];if(!f)return;
  $('#photoLbl').textContent='Preparing…';
  try{photoBlob=await shrinkPhoto(f);const u=URL.createObjectURL(photoBlob);$('#photoPrev').src=u;$('#photoPrev').hidden=false;$('#photoDel').hidden=false;
    $('#photoLbl').textContent='Change photo';}
  catch(err){photoBlob=null;toast(err.message);$('#photoLbl').textContent='Add a photo';}
  e.target.value='';
});
$('#photoDel').addEventListener('click',()=>{photoBlob=null;$('#photoPrev').hidden=true;$('#photoDel').hidden=true;$('#photoLbl').textContent='Add a photo';});
function readForm(){
  const inches=parseFloat($('#addVal').value);
  if(!(inches>=0&&inches<=60)){toast('Enter the ice thickness in inches, 0 to 60.');return null;}
  const snow=parseFloat($('#addSnow').value),note=$('#addNote').value.trim().slice(0,140);
  return {inches:Math.round(inches*2)/2,snow_inches:isNaN(snow)?null:Math.max(0,Math.min(48,snow)),ice:$('#addIce').value||null,note:note||null};
}
async function submitReading(l,lon,lat){
  const f=readForm();if(!f)return false;
  toast('Saving…',20000);
  let photo_path=null;
  if(photoBlob){
    photo_path=`${user.id}/${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}.jpg`;
    const {error}=await supabase.storage.from('photos').upload(photo_path,photoBlob,{contentType:'image/jpeg',cacheControl:'31536000'});
    if(error){toast('The photo did not upload: '+error.message,4500);return false;}
  }
  const {error}=await supabase.from('readings').insert({lake_id:l.id,...f,photo_path,location:`SRID=4326;POINT(${lon} ${lat})`});
  if(error){
    if(photo_path)supabase.storage.from('photos').remove([photo_path]);
    toast(error.code==='23514'?`That spot is not on ${label(l)}. Reports can only go on the lake.`:'Could not save the report: '+error.message,4500);return false;}
  $('#addNote').value='';$('#photoDel').click();
  await refresh();selected=l.id;map.setFilter('sel',['==',['get','id'],l.id]);renderList();
  closeReport();
  toast(`Saved ${fmt(f.inches)} in on ${label(l)}. It now averages ${fmt(lakeInfo(l.id).avg)} in. Thanks!`,4500);
  return true;
}
function setAdding(on){adding=on;$('#addBtn').setAttribute('aria-pressed',String(on));document.body.classList.toggle('adding',on);
  if(on){$('#rp').classList.add('peek');toast(map.getZoom()<11?'Zoom in on the spot you measured, then tap the lake.':'Tap the spot on the lake where you measured.',6000);}
  else $('#rp').classList.remove('peek');}
$('#addBtn').addEventListener('click',()=>setAdding(!adding));
$('#gpsBtn').addEventListener('click',async()=>{
  const b=$('#gpsBtn');b.disabled=true;
  try{
    toast('Getting your GPS position…',20000);
    const c=await locate();showMe(c);
    map.easeTo({center:[c.longitude,c.latitude],zoom:Math.max(map.getZoom(),14),duration:900});
    if(c.accuracy>75){toast(`GPS is only good to about ${Math.round(c.accuracy)} m right now. Wait a moment and try again, or pick the spot on the map.`,6000);return;}
    const {data,error}=await supabase.rpc('lake_at',{lon:c.longitude,lat:c.latitude});
    if(error)throw new Error('Could not check which lake you are on.');
    if(!data?.length){toast(`You don't seem to be on a lake (GPS ±${Math.round(c.accuracy)} m). Reports can only go on the ice.`,5000);return;}
    const l=lakeInfo(data[0].id,{name:data[0].name});if(!l.county)l.county=data[0].county||'';
    await submitReading(l,c.longitude,c.latitude);
  }catch(e){e.message?toast(e.message,4500):$('#toast').hidden=true;}
  finally{b.disabled=false;}
});

map.on('click',async e=>{
  const {x,y}=e.point,ll=e.lngLat;
  const f=map.queryRenderedFeatures(e.point,{layers:['water']})[0];
  if(adding){
    if(!f){toast('That spot is on land. Reports can only go on water.');return;}
    if(map.getZoom()<11){map.easeTo({center:ll,zoom:12.5,duration:800});toast('Zoomed in. Now tap the exact spot you measured.');return;}
    const l=lakeInfo(f.properties.id,f.properties);
    await loadGeom(l);
    if(l.geom&&!inLake(l,ll.lng,ll.lat)){toast(`That spot is right on the ${label(l)} shoreline. Tap a little farther out.`);return;}
    await submitReading(l,ll.lng,ll.lat);
    return;
  }
  if(pinAlpha(map.getZoom())>0.3){let best=null,bd=18*18;
    for(const [px,py,r] of pinsOnScreen){const d=(px-x)**2+(py-y)**2;if(d<bd){bd=d;best=r;}}
    if(best){showPop(best);selectLake(best.lake,false);return;}}
  hidePop();
  if(f)selectLake(f.properties.id,false,f.properties);else clearSel();
});

async function deleteReading(r){
  const {error}=await supabase.from('readings').delete().eq('id',r.id);
  if(error){toast('Could not delete it: '+error.message);return;}
  if(r.photo)supabase.storage.from('photos').remove([r.photo]);
  hidePop();await refresh();toast('Your report was deleted.');
}

/* ---------- "Notify me" alerts (phone notifications through Web Push) ---------- */
const VAPID=import.meta.env.VITE_VAPID_PUBLIC_KEY;
let alertLake=null,myAlerts=[];
const b64u=s=>{const p='='.repeat((4-s.length%4)%4),b=atob((s+p).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(b,c=>c.charCodeAt(0));};
const isIOS=/iPhone|iPad|iPod/.test(navigator.userAgent),standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone;
function pushNote(){
  if(isIOS&&!standalone)return 'On iPhone, notifications only work after you add IceBuddy to your Home Screen: tap Share, then “Add to Home Screen”, and open it from there.';
  if(!('PushManager' in window))return 'This browser can’t show notifications. Try Chrome or Safari on your phone.';
  if(Notification.permission==='denied')return 'Notifications are blocked for IceBuddy. Allow them in your browser’s site settings, then save the alert again.';
  return 'We’ll ask to send notifications when you save.';
}
function withTimeout(p,ms,msg){return Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error(msg)),ms))]);}
async function ensurePush(){
  if(!('serviceWorker' in navigator)||!('PushManager' in window))throw new Error(pushNote());
  if(isIOS&&!standalone)throw new Error(pushNote());
  const perm=await Notification.requestPermission();
  if(perm!=='granted')throw new Error('Notifications are not allowed, so the alert could not be set. Allow them in your browser’s site settings and try again.');
  if(!VAPID)throw new Error('Notifications aren’t set up on this site yet.');
  const slow='Your phone didn’t finish turning on notifications. Check your connection and try again.';
  const reg=await withTimeout(navigator.serviceWorker.ready,8000,slow);
  let sub;
  try{sub=await reg.pushManager.getSubscription()||await withTimeout(reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64u(VAPID)}),15000,slow);}
  catch(e){throw new Error(e.message===slow?slow:'Could not turn on notifications on this device ('+(e.message||e.name)+').');}
  const j=sub.toJSON();
  const {error}=await supabase.from('push_subscriptions').upsert({endpoint:j.endpoint,user_id:user.id,p256dh:j.keys.p256dh,auth:j.keys.auth});
  if(error)throw new Error('Could not register this phone for notifications: '+error.message);
}
function setAlertLake(l){alertLake=l;$('#alertLakeQ').value=l?label(l)+(l.county?' · '+l.county:''):'';$('#alertLakeHits').hidden=true;}
function openAlert(l){
  needUser('Sign in to get ice alerts',()=>{
    setAlertLake(l||(selected?lakes.get(selected):null)||null);
    $('#alertMsg').textContent='';$('#alertNote').textContent=pushNote();
    if($('#authDlg').open)$('#authDlg').close();
    $('#alertDlg').showModal();if(!alertLake)setTimeout(()=>$('#alertLakeQ').focus(),50);
  });
}
$('#alertsBtn').addEventListener('click',()=>openAlert(null));
$('#acctNewAlert').addEventListener('click',()=>openAlert(null));
$('#alertLakeQ').addEventListener('input',e=>{
  const q=e.target.value.trim(),ul=$('#alertLakeHits');alertLake=null;
  if(q.length<2){ul.hidden=true;return;}
  ul.replaceChildren(...search(q).slice(0,8).map(ix=>{const li=el('li',null,label(ix)+(ix.county?' · '+ix.county:''));
    li.tabIndex=0;li.onclick=()=>setAlertLake(lakeInfo(ix.id));li.onkeydown=ev=>{if(ev.key==='Enter')setAlertLake(lakeInfo(ix.id));};return li;}));
  ul.hidden=!ul.children.length;
});
$('#alertSave').addEventListener('click',async()=>{
  const msg=$('#alertMsg'),inches=parseFloat($('#alertIn').value);
  if(!alertLake){msg.textContent='Pick a lake first.';return;}
  if(!(inches>=0&&inches<=60)){msg.textContent='Enter inches from 0 to 60.';return;}
  $('#alertSave').disabled=true;msg.textContent='Saving…';
  try{
    await ensurePush();
    const {error}=await supabase.from('alerts').insert({lake_id:alertLake.id,metric:$('#alertMetric').value,op:$('#alertOp').value,inches:Math.round(inches*2)/2});
    if(error)throw new Error(error.message);
    msg.textContent='';$('#alertDlg').close();toast(`Alert saved for ${label(alertLake)}.`);await loadAlerts();
  }catch(e){msg.textContent=e.message;}
  finally{$('#alertSave').disabled=false;}
});
async function loadAlerts(){
  if(!user){myAlerts=[];return;}
  const {data}=await supabase.from('alerts').select('id,lake_id,metric,op,inches').order('created_at');
  myAlerts=data||[];renderAlertList();
}
function renderAlertList(){
  const ul=$('#acctAlerts');ul.replaceChildren();
  if(!myAlerts.length){ul.append(el('li','empty','No alerts yet. Open a lake and tap “Notify me”.'));return;}
  for(const a of myAlerts){
    const l=lakeInfo(a.lake_id,{name:INDEX.get(a.lake_id)?.name});
    const li=el('li',null,`${label(l)}: ${a.metric==='average'?'average':'any report'} ${a.op==='gte'?'>':'<'} ${fmt(+a.inches)} in`);
    const x=el('button','link','Delete');x.onclick=async()=>{await supabase.from('alerts').delete().eq('id',a.id);await loadAlerts();};
    li.append(x);ul.append(li);
  }
}
const tip=$('#tip');
map.on('mousemove',e=>{
  const f=map.queryRenderedFeatures(e.point,{layers:['water']})[0];
  map.getCanvas().style.cursor=adding?'':f?'pointer':'';
  if(!f||matchMedia('(hover: none)').matches){tip.hidden=true;return;}
  const l=lakes.get(f.properties.id)||INDEX.get(f.properties.id)||{name:f.properties.name,acres:f.properties.acres};
  tip.replaceChildren(el('b',null,label(l)),el('span',null,' · '+[l.county,acresTxt(l.acres)].filter(Boolean).join(' · ')+(l.avg!=null?` · ${fmt(l.avg)} in avg`:'')));
  tip.style.left=e.point.x+'px';tip.style.top=e.point.y+'px';tip.hidden=false;
});
map.getCanvas().addEventListener('mouseleave',()=>tip.hidden=true);
$('#radius').addEventListener('input',e=>{radiusM=+e.target.value;$('#radiusOut').textContent=(radiusM/1000).toFixed(1)+' km';draw();});
$('#zin').onclick=()=>map.zoomIn();$('#zout').onclick=()=>map.zoomOut();
$('#satBtn').onclick=()=>setSatellite(!satellite);
window.icebuddyMap=map;

/* ---------- start ---------- */
async function refresh(){
  for(const l of lakes.values())l.avg=null;
  await loadReports();stats();
  await loadGeoms(reported());
  syncStates();renderList();draw();
}
let ready;const mapLoaded=new Promise(r=>ready=r);function mapReady(){ready();}
const {data:{session}}=await supabase.auth.getSession();user=session?.user??null;
await Promise.all([loadReports(),loadProfile().then(loadAlerts)]);renderAuth();stats();
await mapLoaded;
await loadGeoms(reported());
syncStates();renderList();draw();
// a notification links to ?lake=<id>
const deep=new URLSearchParams(location.search).get('lake');
if(deep&&/^[a-z]{2,8}:[A-Za-z0-9]+$/.test(deep)){history.replaceState(null,'',location.pathname);selectLake(deep,true);}
setInterval(()=>{if(!document.hidden)refresh();},120000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
if('serviceWorker' in navigator&&import.meta.env.PROD)navigator.serviceWorker.register(import.meta.env.BASE_URL+'sw.js').catch(()=>{});
