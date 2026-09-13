"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), test = require("node:test");
const jsx = fs.readFileSync(path.resolve(__dirname, "../../extension/jsx/AEFT/composition-copy.jsx"), "utf8");
function harness(capacity, options = {}) {
  let nextId=1;
  const items=[], placed=[], routes={}, groups=[], clone=v=>JSON.parse(JSON.stringify(v));
  class Property {
    constructor(value,keys=[]) {this.base=clone(value);this.keys=clone(keys);this.expression="";this.expressionEnabled=false;this.canSetExpression=true;}
    get value(){return clone(this.keys.length?this.keys[0].value:this.base);} get numKeys(){return this.keys.length;}
    keyValue(i){return clone(this.keys[i-1].value);} keyTime(i){return this.keys[i-1].time;} valueAtTime(){return this.value;}
    setValue(v){if(this.numKeys||this.fail)throw Error("write failed");this.base=clone(v);}
    setValueAtKey(i,v){if(this.fail)throw Error("write failed");this.keys[i-1].value=clone(v);}
    copy(){const p=new Property(this.base,this.keys);Object.assign(p,{expression:this.expression,expressionEnabled:this.expressionEnabled,fail:this.fail});return p;}
  }
  class Group {
    constructor(children){this.children=children;} get numProperties(){return this.children.length;}
    property(k){return typeof k==="number"?this.children[k-1]:this.children.find(p=>p.matchName===k);}
  }
  class Layer extends Group {
    constructor(name,text){const doc=new Property({text,font:"TemplateFont",fontSize:48});doc.matchName="ADBE Text Document";const textGroup=new Group([doc]);textGroup.matchName="ADBE Text Properties";super(text===null?[]:[textGroup]);this.doc=text===null?null:doc;this.name=name;this.locked=false;this.inPoint=0.5;this.outPoint=4;this.startTime=0;this.stretch=100;}
    copy(){const l=new Layer(this.name,null);l.children=this.children.map(function cp(p){const q=p instanceof Group?new Group(p.children.map(cp)):p.copy();q.matchName=p.matchName;return q;});l.doc=l.property("ADBE Text Properties")?.property("ADBE Text Document");for(const k of ["locked","inPoint","outPoint","startTime","stretch","source"])l[k]=this[k];return l;}
    replaceSource(comp){this.source=comp;} remove(){this.removed=true;}
  }
  class CompItem {
    constructor(name,layers){this.id=nextId++;this.name=name;this.list=layers;this.time=1;this.width=1920;this.height=1080;this.duration=5;this.selectedLayers=[];items.push(this);this.reindex();this.layers={add:comp=>{if(options.failPlace)throw Error("place failed");const l=new Layer(comp.name,null);l.source=comp;this.list.unshift(l);this.reindex();placed.push(l);return l;}};}
    reindex(){this.list.forEach((l,i)=>{l.index=i+1;l.containingComp=this;});} get numLayers(){return this.list.length;} layer(i){return this.list[i-1];}
    duplicate(){return new CompItem(this.name+" 2",this.list.map(l=>l.copy()));} remove(){this.removed=true;}
  }
  class FolderItem {constructor(name){this.name=name;this.id=nextId++;items.push(this);}remove(){this.removed=true;}}
  const sources=new CompItem("Sources",Array.from({length:5},(_,i)=>new Layer("Source "+(i+1),"Text "+(i+1))));
  const template=new CompItem("Template",Array.from({length:capacity},(_,i)=>new Layer("Slot "+(i+1),"Original "+(i+1))));
  const project={activeItem:sources,get numItems(){return items.length;},item:i=>items[i-1],items:{addFolder:n=>new FolderItem(n)}};
  const app={project,beginUndoGroup:n=>groups.push(n),endUndoGroup:()=>groups.pop()};
  const ctx=vm.createContext({app,CompItem,FolderItem,$:{_LWS:{register:(n,h)=>{routes[n]=h;},errorObject:(code,message,details)=>({code,message,details})}}});vm.runInContext(jsx,ctx);
  function call(route,params={}){ctx.params=JSON.stringify(params);ctx.handler=routes[route];return vm.runInContext("handler(JSON.parse(params))",ctx);}
  function record(indices=[1,2,3,4,5]){return indices.map(i=>{sources.selectedLayers=[sources.layer(i)];return call("ae.comp.copy.snapshot").data.layers[0].layerId;});}
  function create(tokens=record()){return call("ae.comp.copy.create",{sourceCompId:sources.id,targetCompId:sources.id,sourceLayerIds:tokens,templateCompId:template.id});}
  return {call,record,create,sources,template,items,placed,groups,app,CompItem,Layer,Property,Group};
}
test("5 texts and 1 slot produce 5 independent whole compositions",()=>{const h=harness(1);assert.equal(h.create().data.count,5);assert.deepEqual(h.placed.map(l=>l.source.layer(1).doc.value.text),["Text 1","Text 2","Text 3","Text 4","Text 5"]);assert.equal(h.template.layer(1).doc.value.text,"Original 1");assert.deepEqual(h.groups,[]);});
test("5 texts and 2 slots use recorded order; final unmatched text remains original",()=>{const h=harness(2),ids=h.record([5,2,1,4,3]);h.app.project.activeItem=h.template;assert.equal(h.create(ids).data.count,3);assert.deepEqual(h.placed.map(l=>l.source.list.map(t=>t.doc.value.text)),[["Text 5","Text 2"],["Text 1","Text 4"],["Text 3","Original 2"]]);});
test("references survive reordering on AE without Layer.id",()=>{const h=harness(1),ids=h.record();h.sources.list.reverse();h.sources.reindex();assert.equal(h.create(ids).data.count,5);assert.equal(h.placed[0].source.layer(1).doc.value.text,"Text 1");});
test("deleted source or invalid target rejects before creating anything",()=>{const h=harness(1),ids=h.record();h.sources.list.shift();h.sources.reindex();assert.equal(h.create(ids).ok,false);assert.equal(h.placed.length,0);assert.equal(h.call("ae.comp.copy.create",{sourceCompId:h.sources.id,targetCompId:999,templateCompId:h.template.id,sourceLayerIds:ids}).ok,false);});
test("Source Text keys keep time and expressions while source font and size are applied",()=>{const h=harness(1),p=h.template.layer(1).doc;p.keys=[{time:0.2,value:{text:"Old",fontSize:18}},{time:3.4,value:{text:"Old",fontSize:62}}];p.expression="value";p.expressionEnabled=true;h.template.layer(1).locked=true;assert.equal(h.create().data.count,5);const l=h.placed[0].source.layer(1);assert.deepEqual(l.doc.keys,[{time:0.2,value:{text:"Text 1",font:"TemplateFont",fontSize:48}},{time:3.4,value:{text:"Text 1",font:"TemplateFont",fontSize:48}}]);assert.equal(l.doc.expression,"value");assert.equal(l.locked,true);assert.equal(l.inPoint,0.5);assert.equal(l.outPoint,4);assert.equal(p.keys[0].value.text,"Old");});
test("source text font and size are applied to each copied composition slot",()=>{const h=harness(1),source=h.sources.layer(1).doc,target=h.template.layer(1).doc;source.base.font="SourceFont";source.base.fontSize=96;target.base.font="TemplateFont";target.base.fontSize=24;const ids=h.record([1]);assert.equal(h.create(ids).data.count,1);const copied=h.placed[0].source.layer(1).doc.value;assert.equal(copied.text,"Text 1");assert.equal(copied.font,"SourceFont");assert.equal(copied.fontSize,96);assert.equal(target.value.font,"TemplateFont");assert.equal(target.value.fontSize,24);});
test("failed text writes or placement roll back generated comps",()=>{for(const failPlace of [false,true]){const h=harness(1,{failPlace});h.template.layer(1).doc.fail=!failPlace;assert.equal(h.create().ok,false);assert.deepEqual(h.items.filter(i=>!i.removed).map(i=>i.name),["Sources","Template"]);assert.deepEqual(h.groups,[]);}});
test("text-linked effects refer to each new comp; comments and string contents stay literal",()=>{const h=harness(1),layer=new h.Layer("Petals",null),p=new h.Property([1,2]),other=new h.Property(3);p.expression='comp("Template").layer("Slot 1").sourceRectAtTime(time,false).width';p.expressionEnabled=true;other.expression='// comp("Template")\nvar note = \'comp("Template")\'; thisComp.layer("Slot 1").index';other.expressionEnabled=true;layer.children.push(p,other);h.template.list.push(layer);h.template.reindex();h.create();const c=h.placed[0].source;assert.ok(c.layer(2).property(1).expression.includes(c.name));assert.equal(c.layer(2).property(2).expression,other.expression);assert.match(p.expression,/comp\("Template"\)/);});
test("nested text and supporting precomps are copied separately for each batch",()=>{const h=harness(0),child=new h.CompItem("Nested",[new h.Layer("Nested slot","Child original")]),layer=new h.Layer("Precomp",null);layer.source=child;h.template.list.push(layer);h.template.reindex();const info=h.call("ae.comp.copy.info",{compId:h.template.id}).data;assert.equal(info.textLayers.length,1);assert.equal(info.textLayers[0].path.join("."),"1.1");assert.equal(h.create().data.count,5);assert.equal(h.placed[0].source.layer(1).source.layer(1).doc.value.text,"Text 1");assert.notEqual(h.placed[0].source.layer(1).source,h.placed[1].source.layer(1).source);assert.equal(child.layer(1).doc.value.text,"Child original");});
test("index selectors adapt character count while keyframe times remain intact",()=>{const h=harness(1),s=new h.Group([]);s.matchName="ADBE Text Selector";for(const [name,value] of [["ADBE Text Range Units",1],["ADBE Text Range Type2",1]]){const p=new h.Property(value);p.matchName=name;s.children.push(p);}const end=new h.Property(0,[{time:0,value:0},{time:4,value:10}]);end.matchName="ADBE Text Index End";s.children.push(end);h.template.layer(1).children.push(s);h.create();assert.deepEqual(h.placed[0].source.layer(1).property(2).property(3).keys,[{time:0,value:0},{time:4,value:6}]);assert.equal(end.keyValue(2),10);});
