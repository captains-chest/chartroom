import{a as e,c as t,d as n,f as r,g as i,h as a,i as o,n as s,r as c,s as l,t as u}from"./shared6.js";import{k as d,l as f,x as p}from"./shared5.js";import{L as m,c as ee,d as h,f as g,g as _,h as v,l as y,m as b,n as x,o as S,p as C,u as w,z as T}from"./shared3.js";import{t as te}from"./shared4.js";import{deviceNodes as E,networkOf as D,placeNodes as O,watchTopology as k}from"./mesh-layer.js";function ne(e,t,n,r,i,a){(a.width!==t.nx||a.height!==t.ny)&&(a.width=t.nx,a.height=t.ny);let o=a.getContext(`2d`),s=o.createImageData(t.nx,t.ny),c=Math.max(1e-6,n[1]-n[0]),l=Math.round(255*_);for(let a=0;a<t.nx*t.ny;a++){let t=Math.min(1,Math.max(0,(e[a*3]-n[0])/c)),o=Math.round(t*255)*4,u=a*4,d=e[a*3+1]<0;s.data[u]=d?l:i[o],s.data[u+1]=d?l:i[o+1],s.data[u+2]=d?l:i[o+2],s.data[u+3]=Math.round(255*r*(d?v:e[a*3+1])*e[a*3+2])}o.putImageData(s,0,0)}var re=class{kind=`canvas`;#e;#t;#n;#r=new Uint8Array;#i=null;#a=null;#o=null;#s=!1;#c=``;#l=0;constructor(e,t){let n=e.getContext(`2d`);if(!n)throw Error(`no Canvas2D`);this.#e=e,this.#t=n,this.#n=t}get busy(){return this.#l>0}setRamp(e){this.#r=e}setLayout(e,t){this.#i=e,this.#c=``,this.#s=t,t||(this.#o=null);let{key:n,grid:r,outline:i,signal:a}=e;a&&this.#u({type:`signal`,key:n,grid:r,outline:i,walls:a.walls,aps:a.aps})}setValues(e){let t=this.#i,n=e.join(`,`);!t?.mesh||this.#l||n===this.#c||this.#u({type:`values`,key:t.key,values:e},n)}#u(e,t=``){this.#l++,this.#n(e).then(n=>{this.#l--,e.key===this.#i?.key&&(n.type===`field`?this.#d(n.field,n.grid):(console.warn(`Chartroom heatmap:`,n),this.#a=this.#o=null),this.#c=t)})}#d(e,t){this.#s&&this.#a&&(this.#o=this.#a,this.#a=null),this.#s=!1,this.#a={field:e,grid:t,img:this.#a?.img??document.createElement(`canvas`)}}dropPrevious(){this.#o=null}draw(e,t,n,r){let i=this.#t,a=this.#e;i.setTransform(1,0,0,1,0,0),i.clearRect(0,0,a.width,a.height);let o=(r,o)=>{ne(r.field,r.grid,t,n,this.#r,r.img);let s=a.width/e.w,c=a.height/e.h;i.globalAlpha=o,i.imageSmoothingEnabled=!0,i.imageSmoothingQuality=`low`,i.drawImage(r.img,(r.grid.x0-e.x)*s,(r.grid.y0-e.y)*c,r.grid.nx*r.grid.cell*s,r.grid.ny*r.grid.cell*c)};this.#o&&r<1&&o(this.#o,1-r),this.#a&&o(this.#a,this.#o&&r<1?r:1),i.globalAlpha=1}readField(){return this.#a?.field??null}dispose(){this.#i=null}},ie=`superseded`,ae=class{#e;#t=new Map;constructor(e=te){this.#e=e.open()}request(e,t){return t===void 0?this.#e.send(e):this.#t.has(t)?(this.#t.get(t)?.resolve({type:`error`,id:0,message:ie}),new Promise(n=>this.#t.set(t,{req:e,resolve:n}))):this.#n(t,e)}#n(e,t){this.#t.set(e,null);let n=this.#e.send(t);return n.then(()=>{let t=this.#t.get(e);t?this.#n(e,t.req).then(t.resolve):this.#t.delete(e)}),n}dispose(){this.#e.close(),this.#t.clear()}},A=`#version 300 es
in vec2 aPos;
void main(){gl_Position=vec4(aPos,0.0,1.0);}`,j=`#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uOutline;
uniform int uOutlineCount;
uniform vec3 uGrid;
uniform vec2 uFade;
out vec4 outField;
float fadeAt(vec2 p){
if(uOutlineCount < 3)return 1.0;
bool inside=false;
float od=1e30;
vec2 prev=texelFetch(uOutline,ivec2(uOutlineCount - 1,0),0).xy;
for(int i=0;i < 16384;i++){
if(i >=uOutlineCount)break;
vec2 cur=texelFetch(uOutline,ivec2(i,0),0).xy;
if((cur.y > p.y)!=(prev.y > p.y)&&
p.x <(prev.x - cur.x)*(p.y - cur.y)/(prev.y - cur.y)+ cur.x)inside=!inside;
vec2 e=cur - prev;
float l2=dot(e,e);
float t=l2 > 0.0?clamp(dot(p - prev,e)/ l2,0.0,1.0):0.0;
vec2 d=p - prev - t*e;
od=min(od,dot(d,d));
prev=cur;
}
return inside?1.0:uFade.x*(1.0 - smoothstep(0.0,uFade.y,sqrt(od)));
}
`,M=`#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uIdx;
uniform sampler2D uW;
uniform sampler2D uVals;
out vec4 outField;
float val(float i){return texelFetch(uVals,ivec2(int(i),0),0).x;}
void main(){
ivec2 c=ivec2(gl_FragCoord.xy);
vec4 i=texelFetch(uIdx,c,0);
vec4 w=texelFetch(uW,c,0);
outField=vec4(w.x*val(i.x)+ w.y*val(i.y)+ w.z*val(i.z),i.w,w.w,1.0);
}`,N=`${j}
uniform sampler2D uWalls;
uniform int uWallCount;
uniform int uApCount;
uniform vec4 uAps[32];
uniform vec2 uModel;
void main(){
vec2 p=uGrid.xy + gl_FragCoord.xy*uGrid.z;
float best=uModel.y;
for(int k=0;k < 32;k++){
if(k >=uApCount)break;
vec2 a=uAps[k].xy;
vec2 r=p - a;
float rx=uAps[k].z - 10.0*uModel.x*log2(max(length(r),1.0))*0.30102999566;
if(rx <=best)continue;
for(int w=0;w < ${u};w++){
if(w >=uWallCount)break;
vec4 s=texelFetch(uWalls,ivec2(w,0),0);
vec2 q=s.xy - a;
vec2 e=s.zw - s.xy;
float den=r.x*e.y - r.y*e.x;
if(abs(den)< 1e-12)continue;
float t=(q.x*e.y - q.y*e.x)/ den;
float u=(q.x*r.y - q.y*r.x)/ den;
if(t > 0.0 && t <=1.0 && u >=0.0 && u <=1.0){
rx -=texelFetch(uWalls,ivec2(w,1),0).x;
if(rx <=best)break;
}
}
best=max(best,rx);
}
outField=vec4(best,1.0,fadeAt(p),1.0);
}`,P=`#version 300 es
in vec2 aPos;
uniform vec3 uGrid;
uniform vec2 uSize;
uniform vec4 uView;
out vec2 vPlan;
void main(){
vec2 p=uGrid.xy + aPos*uSize*uGrid.z;
vPlan=p;
vec2 c=(p - uView.xy)/ uView.zw;
gl_Position=vec4(c.x*2.0 - 1.0,1.0 - c.y*2.0,0.0,1.0);
}`,F=`#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uField;
uniform sampler2D uPrev;
uniform sampler2D uRamp;
uniform vec3 uGrid;
uniform vec2 uSize;
uniform vec3 uPrevGrid;
uniform vec2 uPrevSize;
uniform vec2 uDomain;
uniform float uOpacity;
uniform float uMix;
uniform vec2 uNoData;
in vec2 vPlan;
out vec4 outColour;
vec4 colour(vec4 s){
if(s.y < 0.0){float g=uOpacity*uNoData.y*s.z;return vec4(vec3(uNoData.x)*g,g);}
float t=clamp((s.x - uDomain.x)/ max(1e-6,uDomain.y - uDomain.x),0.0,1.0);
vec3 rgb=texture(uRamp,vec2((t*255.0 + 0.5)/ 256.0,0.5)).rgb;
float a=uOpacity*s.y*s.z;
return vec4(rgb*a,a);
}
vec4 sampleColour(sampler2D f,vec2 cellPos,vec2 size){
vec2 q=cellPos - 0.5;
vec2 fl=floor(q);
vec2 fr=q - fl;
ivec2 i0=ivec2(fl);
ivec2 mx=ivec2(size)- 1;
vec4 a=colour(texelFetch(f,clamp(i0,ivec2(0),mx),0));
vec4 b=colour(texelFetch(f,clamp(i0 + ivec2(1,0),ivec2(0),mx),0));
vec4 c=colour(texelFetch(f,clamp(i0 + ivec2(0,1),ivec2(0),mx),0));
vec4 d=colour(texelFetch(f,clamp(i0 + ivec2(1,1),ivec2(0),mx),0));
return mix(mix(a,b,fr.x),mix(c,d,fr.x),fr.y);
}
void main(){
vec4 now=sampleColour(uField,(vPlan - uGrid.xy)/ uGrid.z,uSize);
if(uMix >=1.0){outColour=now;return;}
vec4 before=sampleColour(uPrev,(vPlan - uPrevGrid.xy)/ uPrevGrid.z,uPrevSize);
outColour=mix(before,now,uMix);
}`;function I(e,t,n){let r=e.createProgram();for(let[i,a]of[[e.VERTEX_SHADER,t],[e.FRAGMENT_SHADER,n]]){let t=e.createShader(i);if(e.shaderSource(t,a),e.compileShader(t),!e.getShaderParameter(t,e.COMPILE_STATUS))throw Error(`shader: ${e.getShaderInfoLog(t)??`compile failed`}`);e.attachShader(r,t)}if(e.linkProgram(r),!e.getProgramParameter(r,e.LINK_STATUS))throw Error(`program: ${e.getProgramInfoLog(r)??`link failed`}`);return r}var L=class{kind=`webgl2`;busy=!1;#e;#t;#n;#r;#i;#a;#o;#s;#c;#l;#u;#d(){return+(this.#f===0)}#f=0;#p=null;#m=null;#h=new Map;constructor(e){let t=e.getContext(`webgl2`,{premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1});if(!t)throw Error(`no WebGL2`);if(!t.getExtension(`EXT_color_buffer_float`))throw Error(`no float render targets`);this.#e=e,this.#t=t,this.#n=I(t,A,M),this.#r=I(t,P,F),this.#i=t.createBuffer(),t.bindBuffer(t.ARRAY_BUFFER,this.#i),t.bufferData(t.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,1,1]),t.STATIC_DRAW),this.#a=this.#g(),this.#o=this.#g(),this.#s=this.#g(),this.#c=this.#g(),this.#l=t.createTexture(),t.bindTexture(t.TEXTURE_2D,this.#l),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),this.#u=[this.#_(),this.#_()]}#g(){let e=this.#t,t=e.createTexture();return e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,1,1,0,e.RGBA,e.FLOAT,new Float32Array(4)),t}#_(){let e=this.#t,t=this.#g(),n=e.createFramebuffer();return e.bindFramebuffer(e.FRAMEBUFFER,n),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0),e.bindFramebuffer(e.FRAMEBUFFER,null),{tex:t,fbo:n,grid:null}}#v(e,t){let n=this.#h.get(e);return n||this.#h.set(e,n=new Map),n.has(t)||n.set(t,this.#t.getUniformLocation(e,t)),n.get(t)}#y(e,t,n,r=1){let i=this.#t;i.bindTexture(i.TEXTURE_2D,e),i.texImage2D(i.TEXTURE_2D,0,i.RGBA32F,Math.max(1,n),r,0,i.RGBA,i.FLOAT,t.length?t:new Float32Array(4*r))}setRamp(e){let t=this.#t;t.bindTexture(t.TEXTURE_2D,this.#l),t.texImage2D(t.TEXTURE_2D,0,t.RGBA8,256,1,0,t.RGBA,t.UNSIGNED_BYTE,e)}setLayout(e,t){let{field:n,signal:r,grid:i,outline:a}=e;r?this.#T(r,i,a,t):n&&this.#b(n,a,t),this.#m=e.mesh}#b(e,t,n){let{grid:r}=e;this.#x(r,t,n);let i=r.nx*r.ny,a=new Float32Array(i*4),o=new Float32Array(i*4);for(let t=0;t<i;t++){for(let n=0;n<3;n++)a[t*4+n]=e.idx[t*3+n],o[t*4+n]=e.w[t*3+n];a[t*4+3]=e.conf[t],o[t*4+3]=e.fade[t]}this.#y(this.#a,a,r.nx,r.ny),this.#y(this.#o,o,r.nx,r.ny),this.#p=e}#x(e,t,n){let r=this.#t;n&&this.#u[this.#f].grid?this.#f=this.#d():this.#u[this.#d()].grid=null;let i=this.#u[this.#f];r.bindTexture(r.TEXTURE_2D,i.tex),r.texImage2D(r.TEXTURE_2D,0,r.RGBA32F,e.nx,e.ny,0,r.RGBA,r.FLOAT,null),i.grid=e;let a=new Float32Array(t.length*4);return t.forEach(([e,t],n)=>a.set([e,t,0,0],n*4)),this.#y(this.#c,a,t.length),this.#p=null,i}#S(e,t,i,a){let o=this.#t;o.bindFramebuffer(o.FRAMEBUFFER,t.fbo),o.viewport(0,0,i.nx,i.ny),o.disable(o.BLEND),o.colorMask(!0,!0,!0,!0),o.useProgram(e),o.activeTexture(o.TEXTURE2),o.bindTexture(o.TEXTURE_2D,this.#c),o.uniform1i(this.#v(e,`uOutline`),2),o.uniform1i(this.#v(e,`uOutlineCount`),a>=3?a:0),o.uniform3f(this.#v(e,`uGrid`),i.x0,i.y0,i.cell),o.uniform2f(this.#v(e,`uFade`),r,n)}#C=null;#w=null;#T(e,t,n,r){let i=this.#t,a=this.#C??=I(i,A,N);this.#w??=this.#g();let o=this.#x(t,n,r),l=Math.min(u,e.walls.length/5),d=new Float32Array(Math.max(1,l)*8);for(let t=0;t<l;t++)d.set(e.walls.subarray(t*5,t*5+4),t*4),d[(Math.max(1,l)+t)*4]=e.walls[t*5+4];this.#y(this.#w,d,Math.max(1,l),2);let f=Math.min(32,e.aps.length/3),p=new Float32Array(128);for(let t=0;t<f;t++)p.set(e.aps.subarray(t*3,t*3+3),t*4);this.#S(a,o,t,n.length),i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,this.#w),i.uniform1i(this.#v(a,`uWalls`),0),i.uniform1i(this.#v(a,`uWallCount`),l),i.uniform1i(this.#v(a,`uApCount`),f),i.uniform4fv(this.#v(a,`uAps`),p),i.uniform2f(this.#v(a,`uModel`),c,s),this.#D(a,[-1,-1,1,-1,-1,1,1,1]),i.bindFramebuffer(i.FRAMEBUFFER,null)}setValues(e){let t=this.#t,n=this.#p;if(!n||!this.#m)return;let r=i(this.#m,e),a=new Float32Array(Math.max(1,n.nodes)*4);for(let e=0;e<n.nodes;e++)a[e*4]=r[e];this.#y(this.#s,a,n.nodes);let o=this.#n;this.#S(o,this.#u[this.#f],n.grid,0),[this.#a,this.#o,this.#s].forEach((e,n)=>{t.activeTexture(t.TEXTURE0+n),t.bindTexture(t.TEXTURE_2D,e),t.uniform1i(this.#v(o,[`uIdx`,`uW`,`uVals`][n]),n)}),this.#D(o,[-1,-1,1,-1,-1,1,1,1]),t.bindFramebuffer(t.FRAMEBUFFER,null)}#E=new Float32Array(8);#D(e,t){let n=this.#t,r=n.getAttribLocation(e,`aPos`);n.bindBuffer(n.ARRAY_BUFFER,this.#i),t?(this.#E.set(t),n.bufferData(n.ARRAY_BUFFER,this.#E,n.DYNAMIC_DRAW)):n.bufferData(n.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,1,1]),n.DYNAMIC_DRAW),n.enableVertexAttribArray(r),n.vertexAttribPointer(r,2,n.FLOAT,!1,0,0),n.drawArrays(n.TRIANGLE_STRIP,0,4),n.disableVertexAttribArray(r)}draw(e,t,n,r){let i=this.#t,a=this.#e.width,o=this.#e.height;i.bindFramebuffer(i.FRAMEBUFFER,null),i.viewport(0,0,a,o),i.clearColor(0,0,0,0),i.clear(i.COLOR_BUFFER_BIT);let s=this.#u[this.#f],c=this.#u[this.#d()];if(!s.grid)return;let l=s.grid,u=this.#r;i.useProgram(u),i.disable(i.BLEND),i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,s.tex),i.uniform1i(this.#v(u,`uField`),0),i.activeTexture(i.TEXTURE1),i.bindTexture(i.TEXTURE_2D,c.grid?c.tex:s.tex),i.uniform1i(this.#v(u,`uPrev`),1),i.activeTexture(i.TEXTURE2),i.bindTexture(i.TEXTURE_2D,this.#l),i.uniform1i(this.#v(u,`uRamp`),2),i.uniform3f(this.#v(u,`uGrid`),l.x0,l.y0,l.cell),i.uniform2f(this.#v(u,`uSize`),l.nx,l.ny);let d=c.grid??l;i.uniform3f(this.#v(u,`uPrevGrid`),d.x0,d.y0,d.cell),i.uniform2f(this.#v(u,`uPrevSize`),d.nx,d.ny),i.uniform4f(this.#v(u,`uView`),e.x,e.y,e.w,e.h),i.uniform2f(this.#v(u,`uDomain`),t[0],t[1]),i.uniform1f(this.#v(u,`uOpacity`),n),i.uniform1f(this.#v(u,`uMix`),c.grid?r:1),i.uniform2f(this.#v(u,`uNoData`),_,v),this.#D(u,null)}dropPrevious(){this.#u[this.#d()].grid=null}readField(){let e=this.#t,t=this.#u[this.#f];if(!t.grid)return null;let n=t.grid.nx*t.grid.ny,r=new Float32Array(n*4);return e.bindFramebuffer(e.FRAMEBUFFER,t.fbo),e.readPixels(0,0,t.grid.nx,t.grid.ny,e.RGBA,e.FLOAT,r),e.bindFramebuffer(e.FRAMEBUFFER,null),r.filter((e,t)=>t%4<3)}dispose(){this.#t.getExtension(`WEBGL_lose_context`)?.loseContext()}};function R(e){let t=e.aps.length/3,{leftOut:n}=e;return[t?x(t,`source`):`No sources`,x(e.walls.length/5,`wall segment`),...n.sources?[`${x(n.sources,`source`)} left out (limit 32)`]:[],...n.segments?[`${x(n.segments,`wall segment`)} left out (limit ${u})`]:[]]}function z(e,t,n=[]){let r=b[e.layer],{unit:i}=e,a=e.readings.map(e=>e.value),o=a.length,s=Math.min(...a),c=Math.max(...a),l=e=>e.toFixed(r.digits),u=e=>`${((e-t[0])/(t[1]-t[0])*100).toFixed(1)}%`,d=e.layer===`signal`,f=d?[...n]:o?[`${l(s)}–${l(c)} ${i}`,x(o,`sensor`)]:[`No readings`];return e.excluded.length&&f.push(`${e.excluded.length} left out`),{title:r.label,unit:i,ramp:h(r.ramp),ticks:o&&!d?[{cls:`min`,left:u(s),title:`Lowest reading ${l(s)} ${i}`},{cls:`max`,left:u(c),title:`Highest reading ${l(c)} ${i}`}]:[],scale:[t[0],(t[0]+t[1])/2,t[1]].map(l),note:f,label:`${r.label} ${l(t[0])} to ${l(t[1])} ${i}. ${f.join(`, `)}`}}function B(e,t,n){let r=n?.querySelector(`:focus`)??null,i=m(`div`,{class:`heat-bar`});i.style.background=t.ramp;for(let e of t.ticks){let t=m(`i`,{class:`heat-tick ${e.cls}`,title:e.title});t.style.left=e.left,i.append(t)}e.replaceChildren(m(`div`,{class:`heat-title`},`${t.title} `,m(`span`,{},t.unit)),i,m(`div`,{class:`heat-scale`},...t.scale.map(e=>m(`span`,{},e))),m(`div`,{class:`heat-note`},t.note.join(` · `))),n&&e.append(n),r?.focus(),e.setAttribute(`aria-label`,t.label),e.hidden=!1}var V=1e3,H=(t,n,r,i=c)=>V-e({walls:t,aps:new Float32Array([n[0],n[1],V])},r[0],r[1],i);function U(e,t,n=c){let r=e.filter(e=>Number.isFinite(e.rssi));if(r.length<3)return null;let i=r.map(e=>H(t,e.a,e.b,n)),a=r.reduce((e,t,n)=>e+t.rssi+i[n],0)/r.length,o=r.reduce((e,t,n)=>e+(t.rssi-a+i[n])**2,0);return{level:a,rms:Math.sqrt(o/r.length),links:r.length}}function W(e,t,n){let r=O(e,t,n),i=new Map,a=new Map;for(let t of e.nodes){let e=r.get(t.id);if(!e)continue;let o=D(t.source),s=i.get(o);s||i.set(o,s={name:o,nodes:new Map,routers:0,links:[],typed:null});let c=(t.entities??[]).map(e=>n?.states?.[e]?.state).filter(e=>e),l=t.role===`coordinator`||t.role===`router`,u=c.length>0&&c.every(e=>e===`unavailable`);s.nodes.set(t.id,{name:t.name||t.id,at:e,router:l,down:u}),l&&s.routers++,a.set(t.id,s)}for(let t of e.links){let e=a.get(t.a);if(!e||e!==a.get(t.b)||typeof t.rssi!=`number`)continue;let[n,r]=[e.nodes.get(t.a).at,e.nodes.get(t.b).at];(n[0]!==r[0]||n[1]!==r[1])&&e.links.push({a:t.a,b:t.b,rssi:t.rssi})}for(let r of t.sources)if(p(r)&&typeof r.tx_dbm==`number`&&r.entity_id)for(let t of E(e,[r.entity_id],null,n)){let e=a.get(t.id);e&&(e.typed??=r.tx_dbm)}return[...i.values()].filter(e=>e.routers>0).sort((e,t)=>t.routers-e.routers)}var G=e=>`${Math.round(e)} dBm`;function oe(e,t){let n=[],r=[],i=U(e.links.map(t=>({a:e.nodes.get(t.a).at,b:e.nodes.get(t.b).at,rssi:t.rssi})),t),a=i?.level??e.typed??d.radio;for(let[t,i]of e.nodes)i.router&&i.down?r.push({id:t,position:i.at}):i.router&&n.push({id:t,position:i.at,value:a});let o=i?`fitted ${G(a)} @1 m · ±${i.rms.toFixed(1)} dB`:`${G(a)} @1 m (${e.typed===null?`default`:`typed`}; ${e.links.length?`${e.links.length} measured, too few to fit`:`no RSSI to fit`})`,s=`${n.length} router${n.length===1?``:`s`}`;return{sources:n,down:r,level:a,fit:i,note:`${e.name} · ${s} · ${o}`}}function K(t,n,r,i,a,o,s){let c=[];for(let l of E(t,a,o,s)){let t=n.nodes.get(l.id);if(!t)continue;let a=r.sources.slice(0,32).filter(e=>e.position[0]!==t.at[0]||e.position[1]!==t.at[1]).flatMap(e=>[e.position[0],e.position[1],e.value]),o=e({walls:i,aps:new Float32Array(a)},t.at[0],t.at[1]);c.push(`Signal map here: ${a.length?G(o):`no other router`}`);for(let e of n.links){let a=e.a===l.id?e.b:e.b===l.id?e.a:null;if(a===null)continue;let o=n.nodes.get(a);c.push(`${o.name}: measured ${G(e.rssi)}, map ${G(r.level-H(i,o.at,t.at))}`)}}return c}var q=.32,se=.24;function J(e,t=.58,n=0){let r=e.chars*t*e.size/2+n;return{x0:e.x-r,x1:e.x+r,y0:e.y-.78*e.size-n,y1:e.y+.22*e.size+n}}function Y(e,t){return e.x0<t.x1&&t.x0<e.x1&&e.y0<t.y1&&t.y0<e.y1}function ce(e,t,n){let r=[...t.map(e=>e.area.size/n<7)],i=t.map(e=>J(e.name,.55)),a=t.map(e=>J(e.area,.55)),o=[],s=2*n;return{values:e.map(e=>{for(let t of[`above`,`below`]){let c=t===`above`?-20:27,l=J({x:e.x,y:e.y+c*n,size:12*n,chars:e.chars},.62,s);if(!(i.some(e=>Y(l,e))||o.some(e=>Y(l,e))))return a.forEach((e,t)=>{!r[t]&&Y(l,e)&&(r[t]=!0)}),o.push(l),t}return`hidden`}),areas:r}}function le(e,t){if(!t||t.layer===`signal`){e.replaceChildren();return}let n=b[t.layer],r=[],i=e=>({x:e[0],y:e[1]});for(let e of t.readings)r.push(T(`text`,{class:`heat-value`,...i(e.position),"data-id":e.id},`${e.value.toFixed(n.digits)}${t.unit===`%`?`%`:`°`}`));for(let e of t.excluded)r.push(T(`text`,{class:`heat-value excluded`,...i(e.position),"data-id":e.id},`–`,T(`title`,{},`${e.entity_id}: ${e.reason}, left out of the heatmap`)));e.replaceChildren(...r)}function ue(e,t,n){let r=(e,t)=>Number(e.getAttribute(t))||0,i=(e,t)=>({x:r(e,`x`),y:r(e,`y`),size:t,chars:e.textContent?.length??0}),a=[...e.querySelectorAll(`text.name`)],o=[...e.querySelectorAll(`text.area`)],s=a.map((e,t)=>({name:i(e,q),area:i(o[t]??e,se)})),c=[...t.querySelectorAll(`text.heat-value`)],l=ce(c.map(e=>({x:r(e,`x`),y:r(e,`y`),chars:e.textContent?.length??0})),s,n);c.forEach((e,t)=>{e.classList.toggle(`below`,l.values[t]===`below`),e.classList.toggle(`crowded`,l.values[t]===`hidden`)}),o.forEach((e,t)=>e.classList.toggle(`crowded`,!!l.areas[t]))}var de=.72,X=`chartroom:signal-network`,Z=``,fe=` .heat-net{margin-top:4px}.heat-net select{pointer-events:auto;max-width:100%;font:inherit;color:inherit;background:none;border:1px solid var(--divider-color,#ccc);border-radius:4px;padding:1px 2px}`,pe={webgl2:e=>new L(e),canvas:(e,t)=>new re(e,t)},Q=(e,t,n)=>n<=0?e.to:e.from+(e.to-e.from)*S((t-e.t0)/n),$=(e,t,n)=>n<=0||t-e.t0>=n||e.from===e.to,me=class{box;legend;#e;#t;#n=new ae;#r=null;#i=null;#a;#o={x:0,y:0,w:1,h:1};#s={w:1,h:1};#c=null;get data(){return this.#c}#l=``;#u=``;#d=null;#f=new Map;#p=null;#m=null;#h=0;#g;#_=``;#v=!1;#y=g(b.temperature.ramp);#b=[];#x=null;#S=null;#C=null;#w=null;#T=null;#E=m(`select`,{"aria-label":`Signal from`});#D=``;picker=m(`div`,{class:`heat-net`},m(`style`,{},fe),this.#E);meshApi=()=>null;#O=[];#k=!1;#A=typeof matchMedia==`function`&&matchMedia(`(prefers-reduced-motion: reduce)`).matches?0:600;onReadings=null;constructor(e,t,n){this.box=e,this.legend=t,this.#t=this.#M(n??(localStorage.getItem(`chartroom:renderer`)===`canvas`?`canvas`:`webgl2`)),this.#E.addEventListener(`change`,()=>{this.#w=this.#E.value;try{localStorage.setItem(X,this.#w)}catch{}this.#P()});try{this.#w=localStorage.getItem(X)}catch{}}get renderer(){return this.#t.kind}get layer(){return this.#r}get mode(){let e=this.#d;return e?e.mesh?.mode??`signal`:`none`}#j(){let e=m(`canvas`,{class:`heat`,"aria-hidden":`true`});return this.box.replaceChildren(e),this.#e=e,this.#N(),e}#M(e){let t=e=>{let t=this.#j();return t.addEventListener(`webglcontextlost`,e=>{e.preventDefault(),t===this.#e&&!this.#k&&this.setRenderer(`canvas`)}),pe[e](t,e=>this.#n.request(e))},n;try{n=t(e)}catch{n=t(`canvas`)}return n.setRamp(this.#y),this.box.dataset.renderer=n.kind,n}setRenderer(e){this.#t.dispose(),this.#t=this.#M(e),this.#d&&this.#z(this.#d,!1)}setLayer(e){e!==this.#r&&(this.#r=e,e&&(this.#y=g(b[e].ramp),this.#t.setRamp(this.#y)),this.#p=null,this.#P())}setPlan(e,t=this.#a,n=!1){this.#i=e,this.#a=t,this.#v=n,this.#P()}setHass(e){this.#a=e,this.#P()}setView(e,t,n){this.#o=e,this.#s={w:t,h:n},this.#N(),this.#G()}#N(){let e=Math.min(2,globalThis.devicePixelRatio||1),t=Math.max(1,Math.round(this.#s.w*e)),n=Math.max(1,Math.round(this.#s.h*e));(this.#e.width!==t||this.#e.height!==n)&&(this.#e.width=t,this.#e.height=n)}#P(){let e=this.#r,r=this.#i;if(clearTimeout(this.#g),!e||!r){this.#L(),this.#c=null,this.#u=this.#l=``,this.#d=null,this.box.hidden=!0,this.legend.hidden=!0,this.#_=``,this.onReadings?.(null,null);return}let i=ee(r,this.#a,e),s=null;e===`signal`?[i,s]=this.#F(r,i):this.#L(),this.#c=i;let c=C(i,this.#a);c<1/0&&!this.#k&&(this.#g=setTimeout(()=>this.#P(),c-Date.now()+1));let l=f(r),u=r.outline,d=s?[]:o(r,this.#a),p=`${e}|${i.unit}|${s?t(s):d.join(`,`)}|${w(i.readings,u)}|${l?[l.minX,l.minY,l.maxX,l.maxY].join(`,`):``}`,m=performance.now(),h=i.readings.map(e=>e.value),g=y(e,i.unit,h);this.#p?this.#p.forEach((e,t)=>{e.to!==g[t]&&Object.assign(e,{from:Q(e,m,this.#A),to:g[t],t0:m})}):this.#p=[{from:g[0],to:g[0],t0:m},{from:g[1],to:g[1],t0:m}];for(let e of i.readings){let t=this.#f.get(e.id);t?t.to!==e.value&&Object.assign(t,{from:Q(t,m,this.#A),to:e.value,t0:m}):this.#f.set(e.id,{from:e.value,to:e.value,t0:m})}let _=s&&!this.picker.hidden?this.picker:null,v=p+JSON.stringify([h,g,i.excluded,this.#b,!!_&&this.#D]),b=v!==this.#_;if(b&&(this.#_=v,B(this.legend,z(i,g,this.#b),_),this.onReadings?.(i,g)),i.readings.length===0)return this.#R(p);let x=this.#v&&!s&&this.#d!==null;if(p!==this.#u&&!x){this.#u=p;let e=l??{minX:0,minY:0,maxX:1,maxY:1},t=i.readings.map(e=>e.id),o=this.#d!==null;if(s){let r={key:p,mesh:null,grid:a(e,n,128),ids:t,outline:u,signal:s};return this.#z(r,o)}let c=a(e);this.#n.request({type:`mesh`,key:p,sensors:i.readings.map(e=>e.position),outline:u,grid:c,walls:d,rooms:r.rooms.map(e=>[...e.polygon])},`layout`).then(e=>{if(p===this.#u){if(e.type===`mesh`)return this.#z({key:p,mesh:e.mesh,field:e.plan,grid:c,ids:t,outline:u},o);console.warn(`Chartroom heatmap:`,e),this.#R(p)}})}else b&&this.#U()}#F(e,t){this.#I();let n=this.#x,r=n?W(n,e,this.#a):[],i=t.readings.length+t.excluded.length>0,a=this.#w===Z&&i?null:r.find(e=>e.name===this.#w)??r[0]??null,o=r.map(e=>[e.name,`${e.name} routers`]);i&&o.push([Z,`Access points and radios`]),this.picker.hidden=o.length<2;let s=o.join(`
`);if(s!==this.#D&&(this.#D=s,this.#E.replaceChildren(...o.map(([e,t])=>m(`option`,{value:e},t)))),this.#E.value=a?.name??Z,!n||!a){this.#T=null;let n=l(e,this.#a,t.readings);return this.#b=R(n),[t,n]}let c=l(e,this.#a,[]).walls,u=oe(a,c),d=l(e,this.#a,u.sources);return this.#T={topology:n,net:a,signal:u,walls:c},this.#b=[u.note,...R(d).slice(1)],[{layer:`signal`,unit:`dBm`,readings:u.sources.map(e=>({...e,entity_id:``})),excluded:u.down.map(e=>({...e,entity_id:``,reason:`unavailable`}))},d]}#I(){let e=this.meshApi();if(e===this.#S||this.#k||(this.#L(),!e))return;this.#S=e;let t=!0;this.#C=k(e,e=>{this.#x=e.topology,t||this.#P()}).stop,t=!1}#L(){this.#C?.(),this.#C=null,this.#S=null,this.#x=null,this.#T=null}probe(e,t){let n=this.#r===`signal`?this.#T:null;return n?K(n.topology,n.net,n.signal,n.walls,e,t,this.#a):[]}#R(e){this.#u=this.#l=e,this.#d=null,this.box.hidden=!0,this.#t.dropPrevious(),this.#q()}#z(e,t){this.box.hidden=!1,this.#d=e,this.#l=e.key;let n=t&&this.#A>0;this.#t.setLayout(e,n),this.#m=n?{from:0,to:1,t0:performance.now()}:null;for(let t of this.#f.keys())e.ids.includes(t)||this.#f.delete(t);this.#U()}#B(e){return this.#d.ids.map(t=>{let n=this.#f.get(t);return n?Q(n,e,this.#A):0})}#V(e){let t=this.#p;return t?[Q(t[0],e,this.#A),Q(t[1],e,this.#A)]:[0,1]}#H(e){let t=this.#d;return t?this.#m&&!$(this.#m,e,this.#A)||this.#p?.some(t=>!$(t,e,this.#A))?!0:t.ids.some(t=>{let n=this.#f.get(t);return!!n&&!$(n,e,this.#A)}):!1}#U(){!this.#h&&!this.#k&&(this.#h=requestAnimationFrame(e=>this.#W(e)))}#W(e){this.#h=0;let t=performance.now(),n=this.#d;if(!n||n.key!==this.#l)return this.#q();let r=this.#t,i=this.#m?Q(this.#m,t,this.#A):1;r.setValues(this.#B(t)),r.draw(this.#o,this.#V(t),de,i);let a=this.#H(t);!a&&this.#m&&(this.#m=null,r.dropPrevious()),a||r.busy?this.#U():this.#q()}#G(){!this.#d||this.#h||this.#U()}#K(){return!this.#h&&!this.#t.busy&&this.#l===this.#u}#q(){if(this.#K())for(let e of this.#O.splice(0))e()}idle(){return this.#K()?Promise.resolve():new Promise(e=>this.#O.push(e))}readField(){return this.#t.readField()}dispose(){this.#L(),this.#k=!0,clearTimeout(this.#g),cancelAnimationFrame(this.#h),this.#h=0,this.#t.dispose(),this.#n.dispose()}};export{me as HeatLayer,ue as declutterLabels,le as renderValueLabels};