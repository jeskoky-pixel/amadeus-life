import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('closing settings and detail consumers preserves the Host-owned shared form for remount and writes', async () => {
 const name=JSON.parse(readFileSync(new URL('../package.json',import.meta.url))).name;
 const bundle=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
 let loaded,effects=[],disposed=false,subscriptions=0;
 const form={getSnapshot:()=>({status:'loading',writable:true,revision:0}),subscribe:()=>{subscriptions++;return()=>subscriptions--},dispose:()=>{disposed=true},mutate:async()=>!disposed};
 const react={createElement:(type,props,...children)=>({type,props:{...props,children}}),useState:v=>[typeof v==='function'?v():v,()=>{}],useRef:v=>({current:v}),useCallback:f=>f,useEffect:f=>effects.push(f)};
 vm.runInNewContext(bundle,{window:{__ModuleLoader__:{load:x=>loaded=x}},navigator:{language:'en-US'},console,URL,AbortController,
  document:{hidden:false,activeElement:null,addEventListener(){},removeEventListener(){}},
  setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
  fetch:async()=>({ok:false,status:503,json:async()=>({ok:false,error:'offline fixture'})})});
 const registrations=[],ctx={
  configForms:{get:()=>form,whileServed:(_ns,fn)=>fn()},
  slots:{inject:(_slot,fn)=>fn(),register:(spec,render)=>{registrations.push({spec,render});return()=>{}}},
  effect:fn=>fn(),
 };
 loaded.factory(()=>react).apply(ctx);
 for(const slot of ['settings.section','plugins.detail.section']){
  const registration=registrations.find(x=>x.spec.name===slot);assert.ok(registration,slot);
  for(let mount=0;mount<2;mount++){
   effects=[];
   const element=registration.render({subject:{kind:'bundle',pkg:{name}}});assert.equal(typeof element.type,'function');
   element.type(element.props);
   const cleanups=effects.map(fn=>fn());
   for(const cleanup of cleanups.reverse())if(typeof cleanup==='function')cleanup();
   await new Promise(resolve=>queueMicrotask(resolve));
   assert.equal(subscriptions,0,'consumer subscriptions must be released');
   assert.equal(disposed,false,'consumer must not dispose the shared provider-owned controller');
   assert.equal(await form.mutate([]),true,'another consumer must still be able to write');
  }
 }
});
