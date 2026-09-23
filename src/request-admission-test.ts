import assert from 'node:assert/strict';
import {RequestAdmission} from './request-admission.js';
let time=0;const g=new RequestAdmission(()=>time);
const a=g.acquire('a')!;assert.ok(a);assert.equal(g.acquire('a'),null);
const b=g.acquire('b')!;assert.ok(b);assert.equal(g.acquire('c'),null);
a();a();const c=g.acquire('c')!;assert.ok(c);b();c();
for(let i=0;i<29;i++){const release=g.acquire('a');assert.ok(release);release();}
assert.equal(g.acquire('a'),null);time=60001;assert.ok(g.acquire('a'));
console.log('PASS admission: one active request per peer, other peer capacity, global cap, idempotent release, rate window.');
