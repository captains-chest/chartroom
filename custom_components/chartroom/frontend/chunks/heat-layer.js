import{n as e}from"./shared2.js";import{d as t}from"./shared3.js";import{C as n,a as r,c as i,f as a,l as o,n as s,o as c,r as l,s as u,x as d}from"./shared4.js";import{d as f,f as p,g as m,h,i as g,l as _,n as v,o as y,r as b,s as x,t as S}from"./shared5.js";var C=.55,w=.35;function T(e,t,n,r,i,a){(a.width!==t.nx||a.height!==t.ny)&&(a.width=t.nx,a.height=t.ny);let o=a.getContext(`2d`),s=o.createImageData(t.nx,t.ny),c=Math.max(1e-6,n[1]-n[0]),l=Math.round(255*C);for(let a=0;a<t.nx*t.ny;a++){let t=Math.min(1,Math.max(0,(e[a*3]-n[0])/c)),o=Math.round(t*255)*4,u=a*4,d=e[a*3+1]<0;s.data[u]=d?l:i[o],s.data[u+1]=d?l:i[o+1],s.data[u+2]=d?l:i[o+2],s.data[u+3]=Math.round(255*r*(d?w:e[a*3+1])*e[a*3+2])}o.putImageData(s,0,0)}var E=class{kind=`canvas`;#e;#t;#n;#r=new Uint8Array;#i=null;#a=null;#o=null;#s=!1;#c=``;#l=0;constructor(e,t){let n=e.getContext(`2d`);if(!n)throw Error(`no Canvas2D`);this.#e=e,this.#t=n,this.#n=t}get busy(){return this.#l>0}setRamp(e){this.#r=e}setLayout(e,t){this.#i=e,this.#c=``,this.#s=t,t||(this.#o=null);let{key:n,grid:r,outline:i,signal:a}=e;a&&this.#u({type:`signal`,key:n,grid:r,outline:i,walls:a.walls,aps:a.aps})}setValues(e){let t=this.#i,n=e.join(`,`);!t?.mesh||this.#l||n===this.#c||this.#u({type:`values`,key:t.key,values:e},n)}#u(e,t=``){this.#l++,this.#n(e).then(n=>{this.#l--,e.key===this.#i?.key&&(n.type===`field`?this.#d(n.field,n.grid):(console.warn(`Chartroom heatmap:`,n),this.#a=this.#o=null),this.#c=t)})}#d(e,t){this.#s&&this.#a&&(this.#o=this.#a,this.#a=null),this.#s=!1,this.#a={field:e,grid:t,img:this.#a?.img??document.createElement(`canvas`)}}dropPrevious(){this.#o=null}draw(e,t,n,r){let i=this.#t,a=this.#e;i.setTransform(1,0,0,1,0,0),i.clearRect(0,0,a.width,a.height);let o=(r,o)=>{T(r.field,r.grid,t,n,this.#r,r.img);let s=a.width/e.w,c=a.height/e.h;i.globalAlpha=o,i.imageSmoothingEnabled=!0,i.imageSmoothingQuality=`low`,i.drawImage(r.img,(r.grid.x0-e.x)*s,(r.grid.y0-e.y)*c,r.grid.nx*r.grid.cell*s,r.grid.ny*r.grid.cell*c)};this.#o&&r<1&&o(this.#o,1-r),this.#a&&o(this.#a,this.#o&&r<1?r:1),i.globalAlpha=1}readField(){return this.#a?.field??null}dispose(){this.#i=null}},D=()=>new Worker(e(),{type:`module`}),O=class{#e=null;#t=null;#n=0;#r=new Map;constructor(e=D){try{let t=e();t.addEventListener(`message`,e=>{let t=this.#r.get(e.data.id);this.#r.delete(e.data.id),t?.resolve(e.data)}),t.addEventListener(`error`,()=>this.#i()),this.#e=t}catch{}}#i(){this.#e?.terminate(),this.#e=null;for(let e of this.#r.values())this.#a(e.req).then(e.resolve);this.#r.clear()}#a(e){return this.#t??=a(()=>import(`./shared.js`).then(e=>e.n).then(e=>e.createHandler()),[],import.meta.url),this.#t.then(t=>t(e)).catch(t=>({type:`error`,id:e.id,message:String(t)}))}request(e){let t={...e,id:++this.#n},n=this.#e;return n?new Promise(e=>{this.#r.set(t.id,{req:t,resolve:e}),n.postMessage(t)}):this.#a(t)}dispose(){this.#e?.terminate(),this.#r.clear()}},k=`#version 300 es
in vec2 aPos;
void main(){gl_Position=vec4(aPos,0.0,1.0);}`,A=`#version 300 es
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
`,j=`#version 300 es
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
}`,M=`${A}
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
for(int w=0;w < ${S};w++){
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
}`,N=`#version 300 es
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
}`,P=`#version 300 es
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
}`;function F(e,t,n){let r=e.createProgram();for(let[i,a]of[[e.VERTEX_SHADER,t],[e.FRAGMENT_SHADER,n]]){let t=e.createShader(i);if(e.shaderSource(t,a),e.compileShader(t),!e.getShaderParameter(t,e.COMPILE_STATUS))throw Error(`shader: ${e.getShaderInfoLog(t)??`compile failed`}`);e.attachShader(r,t)}if(e.linkProgram(r),!e.getProgramParameter(r,e.LINK_STATUS))throw Error(`program: ${e.getProgramInfoLog(r)??`link failed`}`);return r}var I=class{kind=`webgl2`;busy=!1;#e;#t;#n;#r;#i;#a;#o;#s;#c;#l;#u;#d(){return+(this.#f===0)}#f=0;#p=null;#m=null;#h=new Map;constructor(e){let t=e.getContext(`webgl2`,{premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1});if(!t)throw Error(`no WebGL2`);if(!t.getExtension(`EXT_color_buffer_float`))throw Error(`no float render targets`);this.#e=e,this.#t=t,this.#n=F(t,k,j),this.#r=F(t,N,P),this.#i=t.createBuffer(),t.bindBuffer(t.ARRAY_BUFFER,this.#i),t.bufferData(t.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,1,1]),t.STATIC_DRAW),this.#a=this.#g(),this.#o=this.#g(),this.#s=this.#g(),this.#c=this.#g(),this.#l=t.createTexture(),t.bindTexture(t.TEXTURE_2D,this.#l),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),this.#u=[this.#_(),this.#_()]}#g(){let e=this.#t,t=e.createTexture();return e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,1,1,0,e.RGBA,e.FLOAT,new Float32Array(4)),t}#_(){let e=this.#t,t=this.#g(),n=e.createFramebuffer();return e.bindFramebuffer(e.FRAMEBUFFER,n),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0),e.bindFramebuffer(e.FRAMEBUFFER,null),{tex:t,fbo:n,grid:null}}#v(e,t){let n=this.#h.get(e);return n||this.#h.set(e,n=new Map),n.has(t)||n.set(t,this.#t.getUniformLocation(e,t)),n.get(t)}#y(e,t,n,r=1){let i=this.#t;i.bindTexture(i.TEXTURE_2D,e),i.texImage2D(i.TEXTURE_2D,0,i.RGBA32F,Math.max(1,n),r,0,i.RGBA,i.FLOAT,t.length?t:new Float32Array(4*r))}setRamp(e){let t=this.#t;t.bindTexture(t.TEXTURE_2D,this.#l),t.texImage2D(t.TEXTURE_2D,0,t.RGBA8,256,1,0,t.RGBA,t.UNSIGNED_BYTE,e)}setLayout(e,t){let{field:n,signal:r,grid:i,outline:a}=e;r?this.#T(r,i,a,t):n&&this.#b(n,a,t),this.#m=e.mesh}#b(e,t,n){let{grid:r}=e;this.#x(r,t,n);let i=r.nx*r.ny,a=new Float32Array(i*4),o=new Float32Array(i*4);for(let t=0;t<i;t++){for(let n=0;n<3;n++)a[t*4+n]=e.idx[t*3+n],o[t*4+n]=e.w[t*3+n];a[t*4+3]=e.conf[t],o[t*4+3]=e.fade[t]}this.#y(this.#a,a,r.nx,r.ny),this.#y(this.#o,o,r.nx,r.ny),this.#p=e}#x(e,t,n){let r=this.#t;n&&this.#u[this.#f].grid?this.#f=this.#d():this.#u[this.#d()].grid=null;let i=this.#u[this.#f];r.bindTexture(r.TEXTURE_2D,i.tex),r.texImage2D(r.TEXTURE_2D,0,r.RGBA32F,e.nx,e.ny,0,r.RGBA,r.FLOAT,null),i.grid=e;let a=new Float32Array(t.length*4);return t.forEach(([e,t],n)=>a.set([e,t,0,0],n*4)),this.#y(this.#c,a,t.length),this.#p=null,i}#S(e,t,n,r){let i=this.#t;i.bindFramebuffer(i.FRAMEBUFFER,t.fbo),i.viewport(0,0,n.nx,n.ny),i.disable(i.BLEND),i.colorMask(!0,!0,!0,!0),i.useProgram(e),i.activeTexture(i.TEXTURE2),i.bindTexture(i.TEXTURE_2D,this.#c),i.uniform1i(this.#v(e,`uOutline`),2),i.uniform1i(this.#v(e,`uOutlineCount`),r>=3?r:0),i.uniform3f(this.#v(e,`uGrid`),n.x0,n.y0,n.cell),i.uniform2f(this.#v(e,`uFade`),p,f)}#C=null;#w=null;#T(e,t,n,r){let i=this.#t,a=this.#C??=F(i,k,M);this.#w??=this.#g();let o=this.#x(t,n,r),s=Math.min(S,e.walls.length/5),c=new Float32Array(Math.max(1,s)*8);for(let t=0;t<s;t++)c.set(e.walls.subarray(t*5,t*5+4),t*4),c[(Math.max(1,s)+t)*4]=e.walls[t*5+4];this.#y(this.#w,c,Math.max(1,s),2);let l=Math.min(32,e.aps.length/3),u=new Float32Array(128);for(let t=0;t<l;t++)u.set(e.aps.subarray(t*3,t*3+3),t*4);this.#S(a,o,t,n.length),i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,this.#w),i.uniform1i(this.#v(a,`uWalls`),0),i.uniform1i(this.#v(a,`uWallCount`),s),i.uniform1i(this.#v(a,`uApCount`),l),i.uniform4fv(this.#v(a,`uAps`),u),i.uniform2f(this.#v(a,`uModel`),b,v),this.#D(a,[-1,-1,1,-1,-1,1,1,1]),i.bindFramebuffer(i.FRAMEBUFFER,null)}setValues(e){let t=this.#t,n=this.#p;if(!n||!this.#m)return;let r=m(this.#m,e),i=new Float32Array(Math.max(1,n.nodes)*4);for(let e=0;e<n.nodes;e++)i[e*4]=r[e];this.#y(this.#s,i,n.nodes);let a=this.#n;this.#S(a,this.#u[this.#f],n.grid,0),[this.#a,this.#o,this.#s].forEach((e,n)=>{t.activeTexture(t.TEXTURE0+n),t.bindTexture(t.TEXTURE_2D,e),t.uniform1i(this.#v(a,[`uIdx`,`uW`,`uVals`][n]),n)}),this.#D(a,[-1,-1,1,-1,-1,1,1,1]),t.bindFramebuffer(t.FRAMEBUFFER,null)}#E=new Float32Array(8);#D(e,t){let n=this.#t,r=n.getAttribLocation(e,`aPos`);n.bindBuffer(n.ARRAY_BUFFER,this.#i),t?(this.#E.set(t),n.bufferData(n.ARRAY_BUFFER,this.#E,n.DYNAMIC_DRAW)):n.bufferData(n.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,1,1]),n.DYNAMIC_DRAW),n.enableVertexAttribArray(r),n.vertexAttribPointer(r,2,n.FLOAT,!1,0,0),n.drawArrays(n.TRIANGLE_STRIP,0,4),n.disableVertexAttribArray(r)}draw(e,t,n,r){let i=this.#t,a=this.#e.width,o=this.#e.height;i.bindFramebuffer(i.FRAMEBUFFER,null),i.viewport(0,0,a,o),i.clearColor(0,0,0,0),i.clear(i.COLOR_BUFFER_BIT);let s=this.#u[this.#f],c=this.#u[this.#d()];if(!s.grid)return;let l=s.grid,u=this.#r;i.useProgram(u),i.disable(i.BLEND),i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,s.tex),i.uniform1i(this.#v(u,`uField`),0),i.activeTexture(i.TEXTURE1),i.bindTexture(i.TEXTURE_2D,c.grid?c.tex:s.tex),i.uniform1i(this.#v(u,`uPrev`),1),i.activeTexture(i.TEXTURE2),i.bindTexture(i.TEXTURE_2D,this.#l),i.uniform1i(this.#v(u,`uRamp`),2),i.uniform3f(this.#v(u,`uGrid`),l.x0,l.y0,l.cell),i.uniform2f(this.#v(u,`uSize`),l.nx,l.ny);let d=c.grid??l;i.uniform3f(this.#v(u,`uPrevGrid`),d.x0,d.y0,d.cell),i.uniform2f(this.#v(u,`uPrevSize`),d.nx,d.ny),i.uniform4f(this.#v(u,`uView`),e.x,e.y,e.w,e.h),i.uniform2f(this.#v(u,`uDomain`),t[0],t[1]),i.uniform1f(this.#v(u,`uOpacity`),n),i.uniform1f(this.#v(u,`uMix`),c.grid?r:1),i.uniform2f(this.#v(u,`uNoData`),C,w),this.#D(u,null)}dropPrevious(){this.#u[this.#d()].grid=null}readField(){let e=this.#t,t=this.#u[this.#f];if(!t.grid)return null;let n=t.grid.nx*t.grid.ny,r=new Float32Array(n*4);return e.bindFramebuffer(e.FRAMEBUFFER,t.fbo),e.readPixels(0,0,t.grid.nx,t.grid.ny,e.RGBA,e.FLOAT,r),e.bindFramebuffer(e.FRAMEBUFFER,null),r.filter((e,t)=>t%4<3)}dispose(){this.#t.getExtension(`WEBGL_lose_context`)?.loseContext()}},L=(e,t)=>`${e} ${t}${e===1?``:`s`}`;function R(e,t,n=[]){let r=s[e.layer],{unit:a}=e,o=e.readings.map(e=>e.value),c=o.length,l=Math.min(...o),u=Math.max(...o),d=e=>e.toFixed(r.digits),f=e=>`${((e-t[0])/(t[1]-t[0])*100).toFixed(1)}%`,p=e.layer===`signal`,m=p?[...n]:c?[`${d(l)}–${d(u)} ${a}`,L(c,`sensor`)]:[`No readings`];return e.excluded.length&&m.push(`${e.excluded.length} left out`),{title:r.label,unit:a,ramp:i(r.ramp),ticks:c&&!p?[{cls:`min`,left:f(l),title:`Lowest reading ${d(l)} ${a}`},{cls:`max`,left:f(u),title:`Highest reading ${d(u)} ${a}`}]:[],scale:[t[0],(t[0]+t[1])/2,t[1]].map(d),note:m,label:`${r.label} ${d(t[0])} to ${d(t[1])} ${a}. ${m.join(`, `)}`}}function z(e,t){let n=d(`div`,{class:`heat-bar`});n.style.background=t.ramp;for(let e of t.ticks){let t=d(`i`,{class:`heat-tick ${e.cls}`,title:e.title});t.style.left=e.left,n.append(t)}e.replaceChildren(d(`div`,{class:`heat-title`},`${t.title} `,d(`span`,{},t.unit)),n,d(`div`,{class:`heat-scale`},...t.scale.map(e=>d(`span`,{},e))),d(`div`,{class:`heat-note`},t.note.join(` · `))),e.setAttribute(`aria-label`,t.label),e.hidden=!1}var B=.32,V=.24;function H(e,t=.58,n=0){let r=e.chars*t*e.size/2+n;return{x0:e.x-r,x1:e.x+r,y0:e.y-.78*e.size-n,y1:e.y+.22*e.size+n}}function U(e,t){return e.x0<t.x1&&t.x0<e.x1&&e.y0<t.y1&&t.y0<e.y1}function W(e,t,n){let r=[...t.map(e=>e.area.size/n<7)],i=t.map(e=>H(e.name,.55)),a=t.map(e=>H(e.area,.55)),o=[],s=2*n;return{values:e.map(e=>{for(let t of[`above`,`below`]){let c=t===`above`?-10:22,l=H({x:e.x,y:e.y+c*n,size:12*n,chars:e.chars},.62,s);if(!(i.some(e=>U(l,e))||o.some(e=>U(l,e))))return a.forEach((e,t)=>{!r[t]&&U(l,e)&&(r[t]=!0)}),o.push(l),t}return`hidden`}),areas:r}}function G(e,t){if(!t||t.layer===`signal`){e.replaceChildren();return}let r=s[t.layer],i=[],a=e=>({x:e[0],y:e[1]});for(let e of t.readings)i.push(n(`text`,{class:`heat-value`,...a(e.position),"data-id":e.id},`${e.value.toFixed(r.digits)}${t.unit===`%`?`%`:`°`}`));for(let e of t.excluded)i.push(n(`text`,{class:`heat-value excluded`,...a(e.position),"data-id":e.id},`–`,n(`title`,{},`${e.entity_id}: ${e.reason}, left out of the heatmap`)));e.replaceChildren(...i)}function K(e,t,n){let r=(e,t)=>Number(e.getAttribute(t))||0,i=(e,t)=>({x:r(e,`x`),y:r(e,`y`),size:t,chars:e.textContent?.length??0}),a=[...e.querySelectorAll(`text.name`)],o=[...e.querySelectorAll(`text.area`)],s=a.map((e,t)=>({name:i(e,B),area:i(o[t]??e,V)})),c=[...t.querySelectorAll(`text.heat-value`)],l=W(c.map(e=>({x:r(e,`x`),y:r(e,`y`),chars:e.textContent?.length??0})),s,n);c.forEach((e,t)=>{e.classList.toggle(`below`,l.values[t]===`below`),e.classList.toggle(`crowded`,l.values[t]===`hidden`)}),o.forEach((e,t)=>e.classList.toggle(`crowded`,!!l.areas[t]))}var q=.72,J={webgl2:e=>new I(e),canvas:(e,t)=>new E(e,t)},Y=(e,t,n)=>n<=0?e.to:e.from+(e.to-e.from)*l((t-e.t0)/n),X=(e,t,n)=>n<=0||t-e.t0>=n||e.from===e.to,Z=class{box;legend;#e;#t;#n=new O;#r=null;#i=null;#a;#o={x:0,y:0,w:1,h:1};#s={w:1,h:1};#c=null;get data(){return this.#c}#l=``;#u=``;#d=null;#f=new Map;#p=null;#m=null;#h=0;#g=``;#_=o(s.temperature.ramp);#v=[];#y=[];#b=!1;#x=typeof matchMedia==`function`&&matchMedia(`(prefers-reduced-motion: reduce)`).matches?0:600;onReadings=null;constructor(e,t,n){this.box=e,this.legend=t,this.#t=this.#C(n??(localStorage.getItem(`chartroom:renderer`)===`canvas`?`canvas`:`webgl2`))}get renderer(){return this.#t.kind}get layer(){return this.#r}get mode(){let e=this.#d;return e?e.mesh?.mode??`signal`:`none`}#S(){let e=d(`canvas`,{class:`heat`,"aria-hidden":`true`});return this.box.replaceChildren(e),this.#e=e,this.#w(),e}#C(e){let t=e=>{let t=this.#S();return t.addEventListener(`webglcontextlost`,e=>{e.preventDefault(),t===this.#e&&!this.#b&&this.setRenderer(`canvas`)}),J[e](t,e=>this.#n.request(e))},n;try{n=t(e)}catch{n=t(`canvas`)}return n.setRamp(this.#_),this.box.dataset.renderer=n.kind,n}setRenderer(e){this.#t.dispose(),this.#t=this.#C(e),this.#d&&this.#D(this.#d,!1)}setLayer(e){e!==this.#r&&(this.#r=e,e&&(this.#_=o(s[e].ramp),this.#t.setRamp(this.#_)),this.#p=null,this.#T())}setPlan(e){this.#i=e,this.#T()}setHass(e){this.#a=e,this.#T()}setView(e,t,n){this.#o=e,this.#s={w:t,h:n},this.#w(),this.#N()}#w(){let e=Math.min(2,globalThis.devicePixelRatio||1),t=Math.max(1,Math.round(this.#s.w*e)),n=Math.max(1,Math.round(this.#s.h*e));(this.#e.width!==t||this.#e.height!==n)&&(this.#e.width=t,this.#e.height=n)}#T(){let e=this.#r,n=this.#i;if(!e||!n){this.#c=null,this.#u=this.#l=``,this.#d=null,this.box.hidden=!0,this.legend.hidden=!0,this.#g=``,this.onReadings?.(null,null);return}let i=r(n,this.#a,e);this.#c=i;let a=t(n),o=n.outline,s=e===`signal`?y(n,this.#a,i.readings):null;this.#v=s?_(s):[];let l=s?[]:g(n,this.#a),d=`${e}|${i.unit}|${s?x(s):l.join(`,`)}|${u(i.readings,o)}|${a?[a.minX,a.minY,a.maxX,a.maxY].join(`,`):``}`,p=performance.now(),m=i.readings.map(e=>e.value),v=c(e,i.unit,m);this.#p?this.#p.forEach((e,t)=>{e.to!==v[t]&&Object.assign(e,{from:Y(e,p,this.#x),to:v[t],t0:p})}):this.#p=[{from:v[0],to:v[0],t0:p},{from:v[1],to:v[1],t0:p}];for(let e of i.readings){let t=this.#f.get(e.id);t?t.to!==e.value&&Object.assign(t,{from:Y(t,p,this.#x),to:e.value,t0:p}):this.#f.set(e.id,{from:e.value,to:e.value,t0:p})}let b=JSON.stringify([d,m,v,i.excluded,this.#v]);if(b!==this.#g&&(this.#g=b,z(this.legend,R(i,v,this.#v)),this.onReadings?.(i,v)),i.readings.length===0)return this.#E(d);if(d!==this.#u){this.#u=d;let e=a??{minX:0,minY:0,maxX:1,maxY:1},t=i.readings.map(e=>e.id),r=this.#d!==null;if(s){let n={key:d,mesh:null,grid:h(e,f,128),ids:t,outline:o,signal:s};return this.#D(n,r)}let c=h(e);this.#n.request({type:`mesh`,key:d,sensors:i.readings.map(e=>e.position),outline:o,grid:c,walls:l,rooms:n.rooms.map(e=>[...e.polygon])}).then(e=>{if(d===this.#u){if(e.type===`mesh`)return this.#D({key:d,mesh:e.mesh,field:e.plan,grid:c,ids:t,outline:o},r);console.warn(`Chartroom heatmap:`,e),this.#E(d)}})}else this.#j()}#E(e){this.#u=this.#l=e,this.#d=null,this.box.hidden=!0,this.#t.dropPrevious(),this.#F()}#D(e,t){this.box.hidden=!1,this.#d=e,this.#l=e.key;let n=t&&this.#x>0;this.#t.setLayout(e,n),this.#m=n?{from:0,to:1,t0:performance.now()}:null;for(let t of this.#f.keys())e.ids.includes(t)||this.#f.delete(t);this.#j()}#O(e){return this.#d.ids.map(t=>{let n=this.#f.get(t);return n?Y(n,e,this.#x):0})}#k(e){let t=this.#p;return t?[Y(t[0],e,this.#x),Y(t[1],e,this.#x)]:[0,1]}#A(e){let t=this.#d;return t?this.#m&&!X(this.#m,e,this.#x)||this.#p?.some(t=>!X(t,e,this.#x))?!0:t.ids.some(t=>{let n=this.#f.get(t);return!!n&&!X(n,e,this.#x)}):!1}#j(){!this.#h&&!this.#b&&(this.#h=requestAnimationFrame(e=>this.#M(e)))}#M(e){this.#h=0;let t=performance.now(),n=this.#d;if(!n||n.key!==this.#l)return this.#F();let r=this.#t,i=this.#m?Y(this.#m,t,this.#x):1;r.setValues(this.#O(t)),r.draw(this.#o,this.#k(t),q,i);let a=this.#A(t);!a&&this.#m&&(this.#m=null,r.dropPrevious()),a||r.busy?this.#j():this.#F()}#N(){!this.#d||this.#h||this.#j()}#P(){return!this.#h&&!this.#t.busy&&this.#l===this.#u}#F(){if(this.#P())for(let e of this.#y.splice(0))e()}idle(){return this.#P()?Promise.resolve():new Promise(e=>this.#y.push(e))}readField(){return this.#t.readField()}dispose(){this.#b=!0,cancelAnimationFrame(this.#h),this.#h=0,this.#t.dispose(),this.#n.dispose()}};export{Z as HeatLayer,K as declutterLabels,G as renderValueLabels};