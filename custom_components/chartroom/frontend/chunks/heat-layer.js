import{n as e}from"./shared2.js";import{P as t,b as n,c as r,l as i,n as a,o,p as s,r as c,s as l,u,v as d}from"./shared4.js";import{i as f,l as p,m,n as h,o as g,p as _,r as v,s as y,t as b,u as x}from"./shared5.js";var S=.55,C=.35,w=`#version 300 es
in vec2 aPos;
void main(){gl_Position=vec4(aPos,0.0,1.0);}`,T=`#version 300 es
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
`,E=`#version 300 es
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
}`,D=`${T}
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
for(int w=0;w < ${b};w++){
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
}`,O=`#version 300 es
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
}`,k=`#version 300 es
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
}`;function A(e,t,n){let r=e.createProgram();for(let[i,a]of[[e.VERTEX_SHADER,t],[e.FRAGMENT_SHADER,n]]){let t=e.createShader(i);if(e.shaderSource(t,a),e.compileShader(t),!e.getShaderParameter(t,e.COMPILE_STATUS))throw Error(`shader: ${e.getShaderInfoLog(t)??`compile failed`}`);e.attachShader(r,t)}if(e.linkProgram(r),!e.getProgramParameter(r,e.LINK_STATUS))throw Error(`program: ${e.getProgramInfoLog(r)??`link failed`}`);return r}var j=class{canvas;gl;#e;#t;#n;#r;#i;#a;#o;#s;#c;#l(){return+(this.#u===0)}#u=0;#d=null;#f=new Map;constructor(e){this.canvas=e;let t=e.getContext(`webgl2`,{premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1});if(!t)throw Error(`no WebGL2`);if(!t.getExtension(`EXT_color_buffer_float`))throw Error(`no float render targets`);this.gl=t,this.#e=A(t,w,E),this.#t=A(t,O,k),this.#n=t.createBuffer(),t.bindBuffer(t.ARRAY_BUFFER,this.#n),t.bufferData(t.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,1,1]),t.STATIC_DRAW),this.#r=this.#p(),this.#i=this.#p(),this.#a=this.#p(),this.#o=this.#p(),this.#s=t.createTexture(),t.bindTexture(t.TEXTURE_2D,this.#s),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),this.#c=[this.#m(),this.#m()]}#p(){let e=this.gl,t=e.createTexture();return e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,1,1,0,e.RGBA,e.FLOAT,new Float32Array(4)),t}#m(){let e=this.gl,t=this.#p(),n=e.createFramebuffer();return e.bindFramebuffer(e.FRAMEBUFFER,n),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0),e.bindFramebuffer(e.FRAMEBUFFER,null),{tex:t,fbo:n,grid:null}}#h(e,t){let n=this.#f.get(e);return n||this.#f.set(e,n=new Map),n.has(t)||n.set(t,this.gl.getUniformLocation(e,t)),n.get(t)}#g(e,t,n,r=1){let i=this.gl;i.bindTexture(i.TEXTURE_2D,e),i.texImage2D(i.TEXTURE_2D,0,i.RGBA32F,Math.max(1,n),r,0,i.RGBA,i.FLOAT,t.length?t:new Float32Array(4*r))}setRamp(e){let t=this.gl;t.bindTexture(t.TEXTURE_2D,this.#s),t.texImage2D(t.TEXTURE_2D,0,t.RGBA8,256,1,0,t.RGBA,t.UNSIGNED_BYTE,e)}setLayout(e,t,n){let{grid:r}=e;this.#_(r,t,n);let i=r.nx*r.ny,a=new Float32Array(i*4),o=new Float32Array(i*4);for(let t=0;t<i;t++){for(let n=0;n<3;n++)a[t*4+n]=e.idx[t*3+n],o[t*4+n]=e.w[t*3+n];a[t*4+3]=e.conf[t],o[t*4+3]=e.fade[t]}this.#g(this.#r,a,r.nx,r.ny),this.#g(this.#i,o,r.nx,r.ny),this.#d=e}#_(e,t,n){let r=this.gl;n&&this.#c[this.#u].grid?this.#u=this.#l():this.#c[this.#l()].grid=null;let i=this.#c[this.#u];r.bindTexture(r.TEXTURE_2D,i.tex),r.texImage2D(r.TEXTURE_2D,0,r.RGBA32F,e.nx,e.ny,0,r.RGBA,r.FLOAT,null),i.grid=e;let a=new Float32Array(t.length*4);return t.forEach(([e,t],n)=>a.set([e,t,0,0],n*4)),this.#g(this.#o,a,t.length),this.#d=null,i}#v(e,t,n,r){let i=this.gl;i.bindFramebuffer(i.FRAMEBUFFER,t.fbo),i.viewport(0,0,n.nx,n.ny),i.disable(i.BLEND),i.colorMask(!0,!0,!0,!0),i.useProgram(e),i.activeTexture(i.TEXTURE2),i.bindTexture(i.TEXTURE_2D,this.#o),i.uniform1i(this.#h(e,`uOutline`),2),i.uniform1i(this.#h(e,`uOutlineCount`),r>=3?r:0),i.uniform3f(this.#h(e,`uGrid`),n.x0,n.y0,n.cell),i.uniform2f(this.#h(e,`uFade`),x,p)}#y=null;#b=null;setSignal(e,t,n,r){let i=this.gl,a=this.#y??=A(i,w,D);this.#b??=this.#p();let o=this.#_(t,n,r),s=Math.min(b,e.walls.length/5),c=new Float32Array(Math.max(1,s)*8);for(let t=0;t<s;t++)c.set(e.walls.subarray(t*5,t*5+4),t*4),c[(Math.max(1,s)+t)*4]=e.walls[t*5+4];this.#g(this.#b,c,Math.max(1,s),2);let l=Math.min(32,e.aps.length/3),u=new Float32Array(128);for(let t=0;t<l;t++)u.set(e.aps.subarray(t*3,t*3+3),t*4);this.#v(a,o,t,n.length),i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,this.#b),i.uniform1i(this.#h(a,`uWalls`),0),i.uniform1i(this.#h(a,`uWallCount`),s),i.uniform1i(this.#h(a,`uApCount`),l),i.uniform4fv(this.#h(a,`uAps`),u),i.uniform2f(this.#h(a,`uModel`),v,h),this.#S(a,[-1,-1,1,-1,-1,1,1,1]),i.bindFramebuffer(i.FRAMEBUFFER,null)}setValues(e){let t=this.gl,n=this.#d;if(!n)return;let r=new Float32Array(Math.max(1,n.nodes)*4);for(let t=0;t<n.nodes;t++)r[t*4]=e[t];this.#g(this.#a,r,n.nodes);let i=this.#e;this.#v(i,this.#c[this.#u],n.grid,0),[this.#r,this.#i,this.#a].forEach((e,n)=>{t.activeTexture(t.TEXTURE0+n),t.bindTexture(t.TEXTURE_2D,e),t.uniform1i(this.#h(i,[`uIdx`,`uW`,`uVals`][n]),n)}),this.#S(i,[-1,-1,1,-1,-1,1,1,1]),t.bindFramebuffer(t.FRAMEBUFFER,null)}#x=new Float32Array(8);#S(e,t){let n=this.gl,r=n.getAttribLocation(e,`aPos`);n.bindBuffer(n.ARRAY_BUFFER,this.#n),t?(this.#x.set(t),n.bufferData(n.ARRAY_BUFFER,this.#x,n.DYNAMIC_DRAW)):n.bufferData(n.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,1,1]),n.DYNAMIC_DRAW),n.enableVertexAttribArray(r),n.vertexAttribPointer(r,2,n.FLOAT,!1,0,0),n.drawArrays(n.TRIANGLE_STRIP,0,4),n.disableVertexAttribArray(r)}draw(e,t,n,r){let i=this.gl,a=this.canvas.width,o=this.canvas.height;i.bindFramebuffer(i.FRAMEBUFFER,null),i.viewport(0,0,a,o),i.clearColor(0,0,0,0),i.clear(i.COLOR_BUFFER_BIT);let s=this.#c[this.#u],c=this.#c[this.#l()];if(!s.grid)return;let l=s.grid,u=this.#t;i.useProgram(u),i.disable(i.BLEND),i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,s.tex),i.uniform1i(this.#h(u,`uField`),0),i.activeTexture(i.TEXTURE1),i.bindTexture(i.TEXTURE_2D,c.grid?c.tex:s.tex),i.uniform1i(this.#h(u,`uPrev`),1),i.activeTexture(i.TEXTURE2),i.bindTexture(i.TEXTURE_2D,this.#s),i.uniform1i(this.#h(u,`uRamp`),2),i.uniform3f(this.#h(u,`uGrid`),l.x0,l.y0,l.cell),i.uniform2f(this.#h(u,`uSize`),l.nx,l.ny);let d=c.grid??l;i.uniform3f(this.#h(u,`uPrevGrid`),d.x0,d.y0,d.cell),i.uniform2f(this.#h(u,`uPrevSize`),d.nx,d.ny),i.uniform4f(this.#h(u,`uView`),e.x,e.y,e.w,e.h),i.uniform2f(this.#h(u,`uDomain`),t[0],t[1]),i.uniform1f(this.#h(u,`uOpacity`),n),i.uniform1f(this.#h(u,`uMix`),c.grid?r:1),i.uniform2f(this.#h(u,`uNoData`),S,C),this.#S(u,null)}dropPrevious(){this.#c[this.#l()].grid=null}get target(){return this.#c[this.#u]}dispose(){this.gl.getExtension(`WEBGL_lose_context`)?.loseContext()}},M=.32,N=.24;function P(e,t=.58,n=0){let r=e.chars*t*e.size/2+n;return{x0:e.x-r,x1:e.x+r,y0:e.y-.78*e.size-n,y1:e.y+.22*e.size+n}}function F(e,t){return e.x0<t.x1&&t.x0<e.x1&&e.y0<t.y1&&t.y0<e.y1}function I(e,t,n){let r=[...t.map(e=>e.area.size/n<7)],i=t.map(e=>P(e.name,.55)),a=t.map(e=>P(e.area,.55)),o=[],s=2*n;return{values:e.map(e=>{for(let t of[`above`,`below`]){let c=t===`above`?-10:22,l=P({x:e.x,y:e.y+c*n,size:12*n,chars:e.chars},.62,s);if(!(i.some(e=>F(l,e))||o.some(e=>F(l,e))))return a.forEach((e,t)=>{!r[t]&&F(l,e)&&(r[t]=!0)}),o.push(l),t}return`hidden`}),areas:r}}var L=.72,R=class{#e=null;#t=null;#n=0;#r=new Map;constructor(){try{this.#e=new Worker(e(),{type:`module`}),this.#e.addEventListener(`message`,e=>{let t=this.#r.get(e.data.id);this.#r.delete(e.data.id),t?.resolve(e.data)}),this.#e.addEventListener(`error`,()=>this.#i())}catch{this.#i()}}#i(){this.#e?.terminate(),this.#e=null,this.#t??=s(()=>import(`./shared.js`).then(e=>e.n).then(e=>e.createHandler()),[],import.meta.url);for(let[e,t]of this.#r)t.resolve({type:`error`,id:e,message:`worker failed`});this.#r.clear()}request(e){let t={...e,id:++this.#n};return this.#e?new Promise(e=>{this.#r.set(t.id,{resolve:e}),this.#e?.postMessage(t)}):(this.#t??=s(()=>import(`./shared.js`).then(e=>e.n).then(e=>e.createHandler()),[],import.meta.url),this.#t.then(e=>e(t)))}dispose(){this.#e?.terminate(),this.#r.clear()}};function z(e,t,n,r,i,a){(a.width!==t.nx||a.height!==t.ny)&&(a.width=t.nx,a.height=t.ny);let o=a.getContext(`2d`),s=o.createImageData(t.nx,t.ny),c=Math.max(1e-6,n[1]-n[0]),l=Math.round(255*S);for(let a=0;a<t.nx*t.ny;a++){let t=Math.min(1,Math.max(0,(e[a*3]-n[0])/c)),o=Math.round(t*255)*4,u=a*4,d=e[a*3+1]<0;s.data[u]=d?l:i[o],s.data[u+1]=d?l:i[o+1],s.data[u+2]=d?l:i[o+2],s.data[u+3]=Math.round(255*r*(d?C:e[a*3+1])*e[a*3+2])}o.putImageData(s,0,0)}var B=class{canvas;ctx;#e=null;#t=null;#n=!1;constructor(e){this.canvas=e;let t=e.getContext(`2d`);if(!t)throw Error(`no Canvas2D`);this.ctx=t}setLayout(e){this.#n=e,e||(this.#t=null)}setField(e,t){this.#n&&this.#e&&(this.#t=this.#e,this.#e=null),this.#n=!1,this.#e={field:e,grid:t,img:this.#e?.img??document.createElement(`canvas`)}}get hasField(){return this.#e!==null}dropPrevious(){this.#t=null}draw(e,t,n,r,i){let{ctx:a,canvas:o}=this;a.setTransform(1,0,0,1,0,0),a.clearRect(0,0,o.width,o.height);let s=(r,s)=>{z(r.field,r.grid,t,n,i,r.img);let c=o.width/e.w,l=o.height/e.h;a.globalAlpha=s,a.imageSmoothingEnabled=!0,a.imageSmoothingQuality=`low`,a.drawImage(r.img,(r.grid.x0-e.x)*c,(r.grid.y0-e.y)*l,r.grid.nx*r.grid.cell*c,r.grid.ny*r.grid.cell*l)};this.#t&&r<1&&s(this.#t,1-r),this.#e&&s(this.#e,this.#t&&r<1?r:1),a.globalAlpha=1}get field(){return this.#e?.field??null}},V=(e,t,n)=>n<=0?e.to:e.from+(e.to-e.from)*c((t-e.t0)/n),H=(e,t,n)=>n<=0||t-e.t0>=n||e.from===e.to,U=class{box;legend;#e;#t=null;#n=null;#r=new R;#i=null;#a=null;#o;#s={x:0,y:0,w:1,h:1};#c={w:1,h:1};#l=null;get data(){return this.#l}#u=``;#d=``;#f=null;#p=new Map;#m=null;#h=null;#g=0;#_=!1;#v=``;#y=``;#b=u(a.temperature.ramp);#x=0;#S=[];#C=typeof matchMedia==`function`&&matchMedia(`(prefers-reduced-motion: reduce)`).matches;onReadings=null;constructor(e,t,n){this.box=e,this.legend=t,this.#e=this.#w(),this.#T(n??(localStorage.getItem(`chartroom:renderer`)===`canvas`?`canvas`:`webgl2`))}get renderer(){return this.#t?`webgl2`:`canvas`}get layer(){return this.#i}get mode(){let e=this.#f;return e?e.mesh?.mode??`signal`:`none`}get ms(){return this.#C?0:600}#w(){let e=d(`canvas`,{class:`heat`,"aria-hidden":`true`});return this.box.replaceChildren(e),e}#T(e){if(this.#t?.dispose(),this.#t=null,this.#n=null,this.#e=this.#w(),this.#E(),e===`webgl2`)try{let e=this.#e;this.#t=new j(e),e.addEventListener(`webglcontextlost`,t=>{t.preventDefault(),e===this.#e&&this.setRenderer(`canvas`)})}catch{this.#t=null,this.#e=this.#w(),this.#E()}this.#t||(this.#n=new B(this.#e)),this.#t?.setRamp(this.#b),this.box.dataset.renderer=this.renderer}setRenderer(e){this.#T(e);let t=this.#f;t?.mesh?this.#O(t,!1):t&&(this.#f=null,this.#d=``,this.#D())}setLayer(e){e!==this.#i&&(this.#i=e,e&&(this.#b=u(a[e].ramp),this.#t?.setRamp(this.#b)),this.#m=null,this.#D())}setPlan(e){this.#a=e,this.#D()}setHass(e){this.#o=e,this.#D()}setView(e,t,n){this.#s=e,this.#c={w:t,h:n},this.#E(),this.#F()}#E(){let e=Math.min(2,globalThis.devicePixelRatio||1),t=Math.max(1,Math.round(this.#c.w*e)),n=Math.max(1,Math.round(this.#c.h*e));(this.#e.width!==t||this.#e.height!==n)&&(this.#e.width=t,this.#e.height=n)}#D(){let e=this.#i,n=this.#a;if(!e||!n){this.#l=null,this.#d=this.#u=``,this.#f=null,this.box.hidden=!0,this.legend.hidden=!0,this.#y=``,this.onReadings?.(null,null);return}let i=o(n,this.#o,e);this.#l=i;let a=t(n),s=n.outline,c=e===`signal`?g(n,this.#o,i.readings):null;this.#x=c?c.walls.length/5:0;let u=c?[]:f(n,this.#o),d=`${e}|${i.unit}|${c?y(c):u.join(`,`)}|${r(i.readings,s)}|${a?[a.minX,a.minY,a.maxX,a.maxY].join(`,`):``}`,m=performance.now(),h=i.readings.map(e=>e.value),v=l(e,i.unit,h);this.#m?this.#m.forEach((e,t)=>{e.to!==v[t]&&Object.assign(e,{from:V(e,m,this.ms),to:v[t],t0:m})}):this.#m=[{from:v[0],to:v[0],t0:m},{from:v[1],to:v[1],t0:m}];for(let e of i.readings){let t=this.#p.get(e.id);t?t.to!==e.value&&Object.assign(t,{from:V(t,m,this.ms),to:e.value,t0:m}):this.#p.set(e.id,{from:e.value,to:e.value,t0:m})}let b=JSON.stringify([d,h,v,i.excluded]);if(b!==this.#y&&(this.#y=b,this.#L(i,v),this.onReadings?.(i,v)),i.readings.length===0)this.#d=this.#u=d,this.#f=null,this.box.hidden=!0,this.#t?.dropPrevious(),this.#n?.dropPrevious(),this.#I();else if(this.box.hidden=!1,d!==this.#d){this.#d=d;let e=a??{minX:0,minY:0,maxX:1,maxY:1},t=i.readings.map(e=>e.id),r=this.#f!==null;if(c){let n=_(e,p,128),i={key:d,mesh:null,grid:n,ids:t,signal:c};if(this.#t)return this.#O(i,r);this.#_=!0,this.#r.request({type:`signal`,key:d,grid:n,outline:s,walls:c.walls,aps:c.aps}).then(e=>{if(this.#_=!1,e.type!==`field`||e.key!==this.#d)return this.#I();this.#O(i,r),this.#n?.setField(e.field,e.grid)});return}let o=_(e);this.#r.request({type:`mesh`,key:d,sensors:i.readings.map(e=>e.position),outline:s,grid:o,walls:u,rooms:n.rooms.map(e=>[...e.polygon])}).then(e=>{e.type===`mesh`&&e.key===this.#d&&this.#O({key:d,mesh:e.mesh,field:e.plan,grid:o,ids:t},r)})}else this.#M()}#O(e,t){this.#f=e,this.#u=e.key,this.#v=``;let n=this.#a?.outline??[],r=t&&this.ms>0;this.#t&&e.field?this.#t.setLayout(e.field,n,r):this.#t&&e.signal?this.#t.setSignal(e.signal,e.grid,n,r):this.#n?.setLayout(r),this.#h=r?{from:0,to:1,t0:performance.now()}:null;for(let t of this.#p.keys())e.ids.includes(t)||this.#p.delete(t);this.#M()}#k(e){return this.#f.ids.map(t=>{let n=this.#p.get(t);return n?V(n,e,this.ms):0})}#A(e){let t=this.#m;return t?[V(t[0],e,this.ms),V(t[1],e,this.ms)]:[0,1]}#j(e){let t=this.#f;return t?this.#h&&!H(this.#h,e,this.ms)||this.#m?.some(t=>!H(t,e,this.ms))?!0:t.ids.some(t=>{let n=this.#p.get(t);return!!n&&!H(n,e,this.ms)}):!1}#M(){this.#g||=requestAnimationFrame(e=>this.#N(e))}#N(e){this.#g=0;let t=performance.now(),n=this.#f;if(!n||n.key!==this.#u)return this.#I();let r=this.#k(t),i=this.#h?V(this.#h,t,this.ms):1,a=this.#A(t);if(this.#t)n.mesh&&this.#t.setValues(m(n.mesh,r)),this.#t.draw(this.#s,a,L,i);else{let e=`${n.key}|${r.join(`,`)}`;n.mesh&&e!==this.#v&&!this.#_&&this.#P(n.key,r,e),this.#n.draw(this.#s,a,L,i,this.#b)}let o=this.#j(t);!o&&this.#h&&(this.#h=null,this.#t?.dropPrevious(),this.#n?.dropPrevious()),o||this.#_?this.#M():this.#I()}#P(e,t,n){this.#_=!0,this.#r.request({type:`values`,key:e,values:t}).then(e=>{this.#_=!1,e.type===`field`&&e.key===this.#u&&(this.#n?.setField(e.field,e.grid),this.#v=n,this.#M())})}#F(){!this.#f||this.#g||this.#M()}#I(){if(!(this.#g||this.#_||this.#u!==this.#d))for(let e of this.#S.splice(0))e()}idle(){return!this.#g&&!this.#_&&this.#u===this.#d?Promise.resolve():new Promise(e=>this.#S.push(e))}#L(e,t){let n=a[e.layer],r=e.readings.map(e=>e.value),o=e=>e.toFixed(n.digits),s=e=>`${((e-t[0])/(t[1]-t[0])*100).toFixed(1)}%`,c=[d(`div`,{class:`heat-title`},`${n.label} `,d(`span`,{},e.unit))],l=d(`div`,{class:`heat-bar`});l.style.background=i(n.ramp);let u=e.layer===`signal`;if(r.length&&!u){let t=Math.min(...r),n=Math.max(...r);for(let[r,i]of[[t,`min`],[n,`max`]]){let t=d(`i`,{class:`heat-tick ${i}`,title:`${i===`min`?`Lowest`:`Highest`} reading ${o(r)} ${e.unit}`});t.style.left=s(r),l.append(t)}}c.push(l,d(`div`,{class:`heat-scale`},d(`span`,{},o(t[0])),d(`span`,{},o((t[0]+t[1])/2)),d(`span`,{},o(t[1]))));let f=[],p=r.length;u?f.push(p?`${p} source${p===1?``:`s`}`:`No sources`,`${this.#x} wall segment${this.#x===1?``:`s`}`):r.length?(f.push(`${o(Math.min(...r))}–${o(Math.max(...r))} ${e.unit}`),f.push(`${r.length} sensor${r.length===1?``:`s`}`)):f.push(`No readings`),e.excluded.length&&f.push(`${e.excluded.length} left out`),c.push(d(`div`,{class:`heat-note`},f.join(` · `))),this.legend.replaceChildren(...c),this.legend.setAttribute(`aria-label`,`${n.label} ${o(t[0])} to ${o(t[1])} ${e.unit}. ${f.join(`, `)}`),this.legend.hidden=!1}debug(){let e=performance.now(),t=this.#k(e),n=this.#f?.mesh;return{renderer:this.renderer,gl:this.#t,c2d:this.#n,layout:this.#f,view:this.#s,values:t,upload:()=>n&&this.#t?.setValues(m(n,t)),domain:this.#A(e),opacity:L,lut:this.#b,canvas:this.#e,outline:this.#a?.outline??[],request:e=>this.#r.request(e),canvasRenderer:e=>new B(e)}}dispose(){cancelAnimationFrame(this.#g),this.#g=0,this.#t?.dispose(),this.#r.dispose()}};function W(e,t){if(!t||t.layer===`signal`){e.replaceChildren();return}let r=a[t.layer],i=[],o=e=>({x:e[0],y:e[1]});for(let e of t.readings)i.push(n(`text`,{class:`heat-value`,...o(e.position),"data-id":e.id},`${e.value.toFixed(r.digits)}${t.unit===`%`?`%`:`°`}`));for(let e of t.excluded)i.push(n(`text`,{class:`heat-value excluded`,...o(e.position),"data-id":e.id},`–`,n(`title`,{},`${e.entity_id}: ${e.reason}, left out of the heatmap`)));e.replaceChildren(...i)}function G(e,t,n){let r=(e,t)=>Number(e.getAttribute(t))||0,i=(e,t)=>({x:r(e,`x`),y:r(e,`y`),size:t,chars:e.textContent?.length??0}),a=[...e.querySelectorAll(`text.name`)],o=[...e.querySelectorAll(`text.area`)],s=a.map((e,t)=>({name:i(e,M),area:i(o[t]??e,N)})),c=[...t.querySelectorAll(`text.heat-value`)],l=I(c.map(e=>({x:r(e,`x`),y:r(e,`y`),chars:e.textContent?.length??0})),s,n);c.forEach((e,t)=>{e.classList.toggle(`below`,l.values[t]===`below`),e.classList.toggle(`crowded`,l.values[t]===`hidden`)}),o.forEach((e,t)=>e.classList.toggle(`crowded`,!!l.areas[t]))}export{U as HeatLayer,G as declutterLabels,W as renderValueLabels};