#!/usr/bin/env node
// Where does V2 actually lose the weeks 1-14 phase?
// Builds a roster with each model from the same draft slot, simulates seasons, and
// reports average points contributed by each individual lineup slot.
const path = require('path');
const cm = path.join(__dirname, 'compare-models.js');

// Reuse the harness internals by importing it as a module would require refactoring;
// instead re-implement the minimal pieces here against the same data.
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const V1 = require(path.join(ROOT, 'static', 'recommender.js'));
const V2 = require(path.join(ROOT, 'static', 'recommender-v2.js'));

const NUM = 12, ROUNDS = 20;
const POS = ['QB', 'RB', 'WR', 'TE'];
const LINEUP = { QB: 1, RB: 2, WR: 3, TE: 1 };
const TEAM_LOADING = { QB: 0.75, WR: 0.65, TE: 0.60, RB: 0.35 };
const TEAM_CV = 0.35;

function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function gauss(r){let u=0,v=0;while(u===0)u=r();while(v===0)v=r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}

const raw = JSON.parse(fs.readFileSync(path.join(ROOT,'app/data/player_cache.json'),'utf8'));
const pj  = JSON.parse(fs.readFileSync(path.join(ROOT,'app/data/projection_cache.json'),'utf8'));
const projMap = Object.fromEntries(pj.players.filter(p=>p.id).map(p=>[p.id,p]));
let players=(Array.isArray(raw)?raw:raw.players).filter(p=>POS.includes(p.pos)).map(p=>({...p,realAdp:p.adp}));
V2.v2AttachEffective(players, projMap, {});
players = players.filter(p=>p._eff);

function assignTruth(rng){
  const curves={}; for(const pos of POS) curves[pos]=players.filter(p=>p.pos===pos).map(p=>p._eff.mean).sort((a,b)=>b-a);
  const adpRank={}; for(const pos of POS) adpRank[pos]=players.filter(p=>p.pos===pos).sort((a,b)=>a.adp-b.adp);
  for(const p of players){
    const i=adpRank[p.pos].indexOf(p), c=curves[p.pos];
    const mean=(c[Math.min(c.length-1,i)] ?? c[c.length-1]) * Math.exp(gauss(rng)*0.30-0.045);
    p._true={mean, cv:p._eff.sd/Math.max(p._eff.mean,0.01), avail:p._eff.avail??1};
  }
}
function snakeSlot(pick){const r=Math.floor((pick-1)/NUM),i=(pick-1)%NUM;return r%2===0?i:NUM-1-i;}
function remainingPicks(from,slot){const o=[];for(let p=from;p<=NUM*ROUNDS;p++)if(snakeSlot(p)===slot)o.push(p);return o;}
const BOT_LIMITS={QB:3,RB:8,WR:10,TE:3};
function botPick(avail,roster,rng){const c={};for(const p of roster)c[p.pos]=(c[p.pos]||0)+1;
  let best=null,bs=Infinity;for(let i=0;i<Math.min(avail.length,40);i++){const p=avail[i];
    if((c[p.pos]||0)>=BOT_LIMITS[p.pos])continue;const s=p.adp+gauss(rng)*Math.max(4,p.adp*0.12);
    if(s<bs){bs=s;best=p;}}return best||avail[0];}

function draft(modelSlot, model, rng){
  const pool=players.slice().sort((a,b)=>a.adp-b.adp);
  const rosters=Array.from({length:NUM},()=>[]);
  for(let pick=1;pick<=NUM*ROUNDS;pick++){
    const slot=snakeSlot(pick); let chosen;
    if(slot===modelSlot){
      const rem=remainingPicks(pick+1,slot); const next=rem[0]??null;
      chosen = model==='v1'
        ? (V1.getTopRecommendations(pool,rosters[slot],pick,'heavy',1,next)[0]||{}).player
        : (V2.getTopRecommendationsV2(pool,rosters[slot],pick,1,next,rem)[0]||{}).player;
      chosen = chosen || pool[0];
    } else chosen = botPick(pool,rosters[slot],rng);
    pool.splice(pool.indexOf(chosen),1);
    rosters[slot].push({...chosen, round: Math.floor((pick-1)/NUM)+1});
  }
  return rosters[modelSlot];
}

// Simulate weeks 1-14 and attribute points to each individual lineup slot.
function slotBreakdown(roster, seasons, rng){
  const acc={QB:0,RB1:0,RB2:0,WR1:0,WR2:0,WR3:0,TE:0,FLEX:0};
  const flexPos={RB:0,WR:0,TE:0};
  let n=0;
  for(let s=0;s<seasons;s++){
    for(let week=1;week<=14;week++){
      const tf={}; const tSig=Math.sqrt(Math.log(1+TEAM_CV**2));
      for(const p of roster) if(p.team) tf[p.team]=tf[p.team]??Math.exp(gauss(rng)*tSig-tSig*tSig/2);
      const scored=roster.map(p=>{
        if(!p._true) return {pos:p.pos,pts:0};
        if(p.bye===week) return {pos:p.pos,pts:0};
        if(rng() > p._true.avail) return {pos:p.pos,pts:0};
        const load=TEAM_LOADING[p.pos]??0.5;
        const tot=Math.sqrt(Math.log(1+p._true.cv**2));
        const ts=Math.sqrt(Math.log(1+TEAM_CV**2))*load;
        const is=Math.sqrt(Math.max(0.01,tot**2-ts**2));
        const idio=Math.exp(gauss(rng)*is-is*is/2);
        return {pos:p.pos,pts:Math.max(0,p._true.mean*((tf[p.team]??1)**load)*idio)};
      });
      const by={}; for(const pos of POS) by[pos]=scored.filter(x=>x.pos===pos).map(x=>x.pts).sort((a,b)=>b-a);
      acc.QB += by.QB[0]??0;
      acc.RB1+= by.RB[0]??0; acc.RB2+= by.RB[1]??0;
      acc.WR1+= by.WR[0]??0; acc.WR2+= by.WR[1]??0; acc.WR3+= by.WR[2]??0;
      acc.TE += by.TE[0]??0;
      const cands=[{p:'RB',v:by.RB[2]??0},{p:'WR',v:by.WR[3]??0},{p:'TE',v:by.TE[1]??0}];
      cands.sort((a,b)=>b.v-a.v);
      acc.FLEX+=cands[0].v; flexPos[cands[0].p]++;
      n++;
    }
  }
  for(const k in acc) acc[k]/= (n/14);   // per-season totals
  const tot=Object.values(acc).reduce((a,b)=>a+b,0);
  return {acc, tot, flexPos, n};
}

const SEASONS=120;
const agg={};
for(const model of ['v1','v2']){
  const sum={QB:0,RB1:0,RB2:0,WR1:0,WR2:0,WR3:0,TE:0,FLEX:0}; let tot=0; const flex={RB:0,WR:0,TE:0};
  const shape={QB:0,RB:0,WR:0,TE:0};
  const SLOTS=12;
  for(let slot=0;slot<SLOTS;slot++){
    const seed=4242+slot*97;
    assignTruth(mulberry32(seed));
    const roster=draft(slot,model,mulberry32(seed+1));
    for(const p of roster) shape[p.pos]++;
    const r=slotBreakdown(roster,SEASONS,mulberry32(seed+7));
    for(const k in sum) sum[k]+=r.acc[k]/SLOTS;
    tot+=r.tot/SLOTS;
    for(const k in flex) flex[k]+=r.flexPos[k];
  }
  agg[model]={sum,tot,flex,shape:Object.fromEntries(Object.entries(shape).map(([k,v])=>[k,v/SLOTS]))};
}

console.log('\nWeeks 1-14 points contributed by each lineup slot (avg per season):\n');
console.log(`${'Slot'.padEnd(8)}${'V1'.padStart(10)}${'V2'.padStart(10)}${'Δ'.padStart(10)}`);
console.log('-'.repeat(38));
for(const k of ['QB','RB1','RB2','WR1','WR2','WR3','TE','FLEX']){
  const a=agg.v1.sum[k], b=agg.v2.sum[k];
  console.log(`${k.padEnd(8)}${a.toFixed(1).padStart(10)}${b.toFixed(1).padStart(10)}${(b-a>=0?'+':'')+(b-a).toFixed(1).padStart(9)}`);
}
console.log('-'.repeat(38));
console.log(`${'TOTAL'.padEnd(8)}${agg.v1.tot.toFixed(1).padStart(10)}${agg.v2.tot.toFixed(1).padStart(10)}${(agg.v2.tot-agg.v1.tot>=0?'+':'')+(agg.v2.tot-agg.v1.tot).toFixed(1).padStart(9)}`);
console.log('\nRoster shape:', 'V1', agg.v1.shape, '\n              V2', agg.v2.shape);
const f1=agg.v1.flex, f2=agg.v2.flex;
const p1=f1.RB+f1.WR+f1.TE, p2=f2.RB+f2.WR+f2.TE;
console.log(`FLEX filled by  V1: RB ${(100*f1.RB/p1).toFixed(0)}% WR ${(100*f1.WR/p1).toFixed(0)}% TE ${(100*f1.TE/p1).toFixed(0)}%`);
console.log(`                V2: RB ${(100*f2.RB/p2).toFixed(0)}% WR ${(100*f2.WR/p2).toFixed(0)}% TE ${(100*f2.TE/p2).toFixed(0)}%`);
