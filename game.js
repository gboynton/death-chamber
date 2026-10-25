'use strict';
// Fixed-step spring physics. World pixels are independent of screen size.
const canvas=document.getElementById('game'),ctx=canvas.getContext('2d');
const ui=Object.fromEntries(['height','best','feedback','phase','meter','health','healthFill','healthBar','pain','room','clock','score','roundResults','finalScore','bestScore','finalBest','recordNote'].map(id=>[id,document.getElementById(id)]));
const P={headRadius:17,bloodPainThreshold:8,vomitSpinThreshold:3.1,vomitSpinDelay:.5,upperArmLength:32,forearmLength:32,gravity:1500,spring:115,damping:0.8,minLaunch:240,pump:650,timingTolerance:1200,recoveryRate:Math.LN2/2,recoveryDelay:1,painThreshold:220,damageRamp:250,pointerRotationSpeed:4,painSpinAcceleration:70,spinDamping:0.22,leanKick:180,step:1/240},surface=590;
let y,velocity,best,bounceHeight,pumped,squish,lastPump,feedbackTime;
let width=1,height=1,scale=1,ox=0,oy=0,previous=0,accumulator=0;
let bodyAngle=0,armAngle=0,angularSpeed=0,gesture=null;
const touchPointers=new Map();
let steeringTouchId=null;
let horizontalPosition=450,horizontalSpeed=0,facing=1;
let painSpinSpeed=0,painTorque=0,painTorqueTarget=0,painNoiseTimer=0;
let roomNumber=1,opening=null;
const ROUND_DURATION_MS=90000;
const BEST_SCORE_KEY='death-chamber-best-90-second-score-v1';
let bestScore=readBestScore(),victoryUntil=-1;
let roundDeadline=null,roundOver=false,remainingMs=ROUND_DURATION_MS,roomTransition=null,ending=null;
let bounceSoundArmed=false,bounceAirTime=0;
let trampolineContact=false;
let headOnBed=false;
let animation;
let bloodParticles=[];
let wallDrips=[],floorFluids={blood:new Float32Array(82),vomit:new Float32Array(82)};
let nauseaTime=0,vomitAccumulator=0,vomiting=false,vomitParticles=[],vomitSeed=937;
let health=100,hitFlash=0,simulationTime=0,lastDamageTime=-10,lastHits={};
function reset(){ending=null;victoryUntil=-1;roundDeadline=null;roundOver=false;remainingMs=ROUND_DURATION_MS;roomTransition=null;ui.roundResults.hidden=true;ui.clock.textContent='1:30';ui.score.textContent='0';resetRoomFluids();bloodParticles=[];resetVomit();resetAnimation();touchPointers.clear();steeringTouchId=null;roomNumber=1;opening=createOpening(roomNumber);trampolineContact=false;bounceSoundArmed=false;bounceAirTime=0;headOnBed=false;painSpinSpeed=0;painTorque=0;painTorqueTarget=0;painNoiseTimer=0;health=100;hitFlash=0;simulationTime=0;lastDamageTime=-10;lastHits={};horizontalPosition=450;horizontalSpeed=0;facing=1;bodyAngle=0;armAngle=0;angularSpeed=0;gesture=null;y=surface-180;velocity=0;best=180;bounceHeight=180;pumped=false;squish=0;lastPump=-10;feedbackTime=2;ui.feedback.textContent='Move or tap to start your 90-second escape.';}
// Each room shrinks the opening by 10%; wall doors retain their extra height.
function createOpening(room){
 const side=['left','right','ceiling'][Math.min(2,Math.floor(Math.random()*3))];
 const size=(220*Math.pow(.9,room-1))*(side==='ceiling'?1:1.3);
 const low=side==='ceiling'?100:150,high=side==='ceiling'?800:550;
 const start=low+Math.random()*(high-low-size);
 return {side,start,end:start+size,size,progress:0};
}
function fitsOpening(g,side){
 if(opening.side!==side||(opening.progress??1)<.05)return false;
 const gap=doorGap();
 return side==='ceiling'?g.left>=gap.start&&g.right<=gap.end:g.torso.y>=gap.start&&g.torso.y<=gap.end;
}
function nextRoom(exitSide=opening.side){
 updateRoundClock();if(roundOver)return;
 const previous=geometry();
 resetRoomFluids();bloodParticles=[];resetVomit();roomNumber++;victoryUntil=simulationTime+1.2;opening=createOpening(roomNumber);
 // Translate the existing pose into the opposite edge, preserving all velocities.
 if(exitSide==='left')horizontalPosition+=848-previous.right;
 else if(exitSide==='right')horizontalPosition+=52-previous.left;
 else{
  // The trampoline is the bottom of the playable area. Enter just above it,
  // so an upward arrival never gets mistaken for a compressed landing.
  y+=surface-8-previous.bottom;
  if(previous.left<52)horizontalPosition+=52-previous.left;
  else if(previous.right>848)horizontalPosition-=previous.right-848;
 }
 trampolineContact=bedState().depth>0;headOnBed=false;
 bounceSoundArmed=false;bounceAirTime=trampolineContact?0:.06;
 lastHits={};bounceHeight=Math.max(0,surface-y);
 message(`Room ${roomNumber}! Keep going!`);feedbackTime=3;
}
function readBestScore(){
 try{const value=Number(localStorage.getItem(BEST_SCORE_KEY));return Number.isSafeInteger(value)&&value>=0?value:0;}catch{return 0;}
}
function recordRoundScore(score){
 bestScore=Math.max(bestScore,readBestScore());
 const newRecord=score>bestScore;
 if(newRecord){bestScore=score;try{localStorage.setItem(BEST_SCORE_KEY,String(bestScore));}catch{}}
 ui.bestScore.textContent=String(bestScore);ui.finalBest.textContent=String(bestScore);
 ui.recordNote.textContent=newRecord?'NEW PERSONAL BEST!':score===bestScore&&score>0?'Matched your best!':'Can you beat your best?';
 return newRecord;
}
function startRound(){
 if(roundOver)return false;
 if(roundDeadline===null)roundDeadline=performance.now()+ROUND_DURATION_MS;
 updateRoundClock();return !roundOver;
}
function updateRoundClock(now=performance.now()){
 if(roundDeadline===null||roundOver)return;
 remainingMs=Math.max(0,roundDeadline-now);
 if(remainingMs===0){
  roundOver=true;clearSteering();const newRecord=recordRoundScore(Math.max(0,roomNumber-1));
  ui.finalScore.textContent=String(Math.max(0,roomNumber-1));ui.roundResults.hidden=true;
  beginGameOver(newRecord);
  message("Time's up!",'#f0d38b');
 }
}
function beginGameOver(newRecord){
 roomTransition=null;vomiting=false;nauseaTime=0;bounceSoundArmed=false;
 const lean=Math.atan2(Math.sin(bodyAngle),Math.cos(bodyAngle));
 const target=lean<0?-Math.PI/2:Math.PI/2;
 ending={phase:'fall',time:0,phaseTime:0,target,newRecord,raise:0,boingPlayed:false};
 velocity=Math.max(0,velocity*.2);horizontalSpeed*=.35;
}
function updateGameOver(dt){
 if(!ending||ending.phase==='done')return;
 dt*=.8; // Gentle slow motion for the final flop and rebound.
 ending.time+=dt;ending.phaseTime+=dt;simulationTime+=dt;
 hitFlash=Math.max(0,hitFlash-dt);
 if(opening.progress!==undefined)opening.progress=Math.max(0,opening.progress-dt*3);
 const turn=Math.atan2(Math.sin(ending.target-bodyAngle),Math.cos(ending.target-bodyAngle));
 bodyAngle+=turn*(1-Math.exp(-5*dt));angularSpeed=0;armAngle=0;
 horizontalSpeed*=Math.exp(-4*dt);horizontalPosition+=horizontalSpeed*dt;
 if(ending.phase==='fall'){
  velocity+=P.gravity*dt;y+=velocity*dt;
  if(geometry().bottom>=surface){
   ending.phase='bounce';ending.phaseTime=0;velocity=0;
   if(!ending.boingPlayed){ending.boingPlayed=true;if(typeof BounceAudio!=='undefined')BounceAudio.boing(130);}
  }
 }else if(ending.phase==='bounce'){
  const t=Math.min(1,ending.phaseTime/1.05),smooth=v=>v*v*(3-2*v);
  let compression;
  if(t<.25)compression=42*smooth(t/.25);
  else if(t<.65)compression=42-58*smooth((t-.25)/.4);
  else compression=-16+30*smooth((t-.65)/.35);
  y+=surface+compression-geometry().bottom;
  if(t===1){ending.phase='rest';ending.phaseTime=0;}
 }else if(ending.phase==='rest'){
  y+=surface+14-geometry().bottom;
  if(ending.newRecord)ending.raise=Math.min(1,ending.raise+dt*1.5);
  if(ending.phaseTime>=1.6){ending.phase='done';ui.roundResults.hidden=false;}
 }
 updateAnimation(dt);
 // Match the animated support to the bed as the limp pose settles.
 if(ending.phase==='rest'||ending.phase==='done')y+=surface+14-geometry().bottom;
 const g=geometry();if(g.left<44)horizontalPosition+=44-g.left;if(g.right>856)horizontalPosition-=g.right-856;
 if(g.top<85){y+=85-g.top;velocity=Math.abs(velocity)*.2;}
 vomitParticles=updateFluidParticles(vomitParticles,'vomit',dt);updateBlood(dt);updateWallDrips(dt);
}
function doorGap(){
 const progress=Math.max(0,Math.min(1,opening.progress??1)),center=(opening.start+opening.end)/2;
 return {start:center-opening.size*progress/2,end:center+opening.size*progress/2};
}
function beginRoomTransition(side){
 if(roomTransition||!startRound())return;
 roomTransition={side,elapsed:0,initialProgress:opening.progress??1};
}
function updateRoomTransition(dt){
 if(!roomTransition||roundOver)return;
 roomTransition.elapsed+=dt;
 opening.progress=roomTransition.initialProgress*Math.max(0,1-roomTransition.elapsed/.25);
 if(roomTransition.elapsed>=.25){const side=roomTransition.side;roomTransition=null;nextRoom(side);}
}
function passedOpening(g){
 return (fitsOpening(g,'left')&&g.torso.x<=40)||
  (fitsOpening(g,'right')&&g.torso.x>=860)||
  (fitsOpening(g,'ceiling')&&g.bottom<85);
}
function resize(){width=innerWidth;height=innerHeight;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=width*dpr;canvas.height=height*dpr;scale=Math.min(width/900,height/820);ox=(width-900*scale)/2;oy=(height-820*scale)/2;ctx.setTransform(dpr,0,0,dpr,0,0);}
function message(text,color='#bde68a'){ui.feedback.textContent=text;ui.feedback.style.color=color;feedbackTime=1.7;}
// Higher timingTolerance accepts clicks farther from the deepest stretch.
function timingScore(){return Math.exp(-Math.pow(velocity/P.timingTolerance,2))*Math.min(bedState().depth/24,1);}
// Pain adds random rotation; deliberate clicks and swipes keep full strength.
function pump(){if(!startRound()||roomTransition)return;const now=performance.now()/1000;if(now-lastPump<.22)return;lastPump=now;squish=1;
 if(bedState().depth<=0){message('Click when the trampoline stretches.','#d4b987');return;}
 // A settled player can always start a fresh jump, even after a spent push.
 if(Math.abs(velocity)<60&&Math.abs(bedState().depth-P.gravity/P.spring)<12){velocity=-P.pump;pumped=true;bounceSoundArmed=true;message('Jump!');return;}
 if(pumped){message('One push per bounce.','#d4b987');return;}pumped=true;
 const timing=timingScore();
 if(timing>.2){velocity-=P.pump*(.65+.35*timing);message(timing>.85?'Perfect. Feel that lift!':'Good push!');}
 else{const early=velocity>0;velocity*=.85;message(early?'Too early — bounce absorbed.':'Too late — catch the next stretch.','#d4b987');}}
function steerBounce(){
 // Sideways and inverted landings coast; only an upright lean redirects travel.
 // Capture once on contact so rotation during compression cannot reverse it.
 if(Math.cos(bodyAngle)<=1e-8)return;
 const lean=Math.sin(bodyAngle);
 horizontalSpeed=Math.abs(lean)<.001?0:P.leanKick*lean;
}
// Shared articulated pose keeps collision anchors aligned with the visible figure.
function updateFacing(){if(Math.abs(horizontalSpeed)>8)facing=Math.sign(horizontalSpeed);}
function faceSign(){return facing*(Math.cos(bodyAngle)>=0?1:-1);}
function characterPose(){
 const crouch=Math.min(1,Math.max(0,y-surface)/85)*.7+squish*.3;
 const pivot=y-48+crouch*20,{bend,lag,tuck,recoil}=animation;
 const hip=pivot+tuck*14+recoil*5;
 const shoulder=hip-39+tuck*12+recoil*9,shoulderX=3+bend*.55;
 return {pivot,hip,shoulder,shoulderX,head:shoulder-(P.headRadius+9)+recoil*5,headX:5+bend*.3,
 nearKnee:[-4-crouch*12-tuck*20+lag*.65,y-26+tuck*13],
 farKnee:[6.5+crouch*9+tuck*14+lag*.4,y-26+tuck*10]};
}
// Match collision geometry to the rendered head and body (arms stay decorative).
function geometry(){
 const pose=characterPose(),c=Math.cos(bodyAngle),s=Math.sin(bodyAngle);
 const point=(dx,dy)=>({x:horizontalPosition+c*dx-s*dy,y:pose.pivot+s*dx+c*dy});
 const head=point(pose.headX,pose.head-pose.pivot);
 const points=[point(-8,y-2-pose.pivot),point(13,y-2-pose.pivot),point(pose.nearKnee[0],pose.nearKnee[1]-pose.pivot),point(pose.farKnee[0],pose.farKnee[1]-pose.pivot),point(0,pose.hip-pose.pivot),point(pose.shoulderX,pose.shoulder-pose.pivot)];
 const support=[{x:head.x,y:head.y+P.headRadius},...points.map(p=>({x:p.x,y:p.y+2}))].reduce((a,b)=>a.y>b.y?a:b);
 return {torso:point(pose.shoulderX/2,(pose.hip+pose.shoulder)/2-pose.pivot),bottom:support.y,supportX:support.x,head,vx:horizontalSpeed+angularSpeed*(61*c-5*s),vy:velocity+angularSpeed*(5*c+61*s),
 left:Math.min(head.x-P.headRadius,...points.map(p=>p.x-3)),right:Math.max(head.x+P.headRadius,...points.map(p=>p.x+3)),
 top:Math.min(head.y-P.headRadius,...points.map(p=>p.y-3))};
}
function bedState(){
 const g=geometry();
 return {depth:Math.max(0,g.bottom-surface),position:Math.max(50,Math.min(850,g.supportX))};
}
function bedHeight(px,position=bedState().position,depth=bedState().depth){
 const t=Math.max(0,Math.min(1,px<=position?(px-40)/(position-40):(860-px)/(860-position)));
 return surface+depth*(.24*(1-t)*t+t*t);
}
function damageFromImpact(speed,cosine,softness=1){
  // Ignore light taps, then ease in damage smoothly instead of a sharp penalty.
 const excess=Math.max(0,speed*Math.max(0,Math.min(1,cosine))-P.painThreshold);
 return excess*excess/(excess+P.damageRamp)*.025*softness;
}
function headImpact(label,nx,ny,softness=1){
 // Damage uses translation normal to the surface, excluding head rotation.
 const normalSpeed=-(horizontalSpeed*nx+velocity*ny);
 if(normalSpeed<=P.painThreshold||simulationTime-(lastHits[label]??-10)<.2)return;
 const damage=damageFromImpact(normalSpeed,1,softness);
 const painIncrement=Math.min(health,damage);
 if(damage>0&&typeof BounceAudio!=='undefined'&&BounceAudio.impact)BounceAudio.impact(normalSpeed,softness);
 if(painIncrement>=P.bloodPainThreshold)spawnBlood(nx,ny,painIncrement);
 lastHits[label]=simulationTime;lastDamageTime=simulationTime;health=Math.max(0,health-damage);hitFlash=.35;
 message(health>0?`Ouch! ${label} · ${damage.toFixed(1)} damage`:'Maximum pain! Give him a moment to recover.','#f39b7d');
}
function resolveCollisions(){
 let g=geometry();
 if(passedOpening(g)){beginRoomTransition(opening.side);return;}
 if(g.left<40&&!fitsOpening(g,'left')){
  if(g.head.x-P.headRadius<=43){headImpact('Left wall',1,0);angularSpeed*=.65;painSpinSpeed*=.65;}
  horizontalPosition+=40-g.left;horizontalSpeed=Math.abs(horizontalSpeed);g=geometry();
 }
 if(g.right>860&&!fitsOpening(g,'right')){
  if(g.head.x+P.headRadius>=857){headImpact('Right wall',-1,0);angularSpeed*=.65;painSpinSpeed*=.65;}
  horizontalPosition-=g.right-860;horizontalSpeed=-Math.abs(horizontalSpeed);g=geometry();
 }
 if(g.top<85&&!fitsOpening(g,'ceiling')){
  if(g.head.y-P.headRadius<=88){headImpact('Ceiling',0,1);angularSpeed*=.65;painSpinSpeed*=.65;}
  y+=85-g.top;velocity=Math.max(150,Math.abs(velocity)*.85);g=geometry();
 }
 // Head landings share the spring response with every other pose.
 // Count one pain event per contact, rather than reflecting off a rigid bed.
 const touchingHead=g.head.y+P.headRadius>=bedHeight(g.head.x)-.5;
 if(touchingHead&&!headOnBed&&velocity>0){headImpact('Trampoline',0,-1,.5);angularSpeed*=.7;painSpinSpeed*=.7;}
 headOnBed=touchingHead;
}
function steeringAxis(){
 if(!gesture)return 0;
 const axis=Math.max(-1,Math.min(1,gesture.x/width*2-1)),deadZone=.1;
 return Math.abs(axis)<=deadZone?0:Math.sign(axis)*(Math.abs(axis)-deadZone)/(1-deadZone);
}
function updateRotationControl(dt){
 if(!gesture)return;
 // Pointer position sets deliberate speed; pain-driven spin stays additive.
 angularSpeed=Math.max(-8,Math.min(8,steeringAxis()*P.pointerRotationSpeed+painSpinSpeed));
}
function updatePainRotation(dt){
 const painFraction=Math.max(0,Math.min(1,(100-health)/100));
 if(painFraction===0){painSpinSpeed=0;painTorque=0;painTorqueTarget=0;painNoiseTimer=0;return;}
 // Cubic pain scaling keeps medium pain manageable, with chaos near maximum.
 // Hold each random torque briefly and smooth it to avoid frame-to-frame jitter.
 painNoiseTimer-=dt;
 if(painNoiseTimer<=0){painTorqueTarget=(Math.random()*2-1)*P.painSpinAcceleration;painNoiseTimer+=.25;}
 painTorque+=(painTorqueTarget-painTorque)*(1-Math.exp(-12*dt));
 const previousPainSpin=painSpinSpeed;
 painSpinSpeed=Math.max(-8,Math.min(8,painSpinSpeed+painTorque*Math.pow(painFraction,3)*dt));
 angularSpeed=Math.max(-8,Math.min(8,angularSpeed+painSpinSpeed-previousPainSpin));
}
// A sound belongs to a landing/rebound cycle, not each geometric contact edge.
function updateBounceSound(dt){
 const g=geometry(),compression=Math.max(0,g.bottom-surface);
 if(g.bottom<surface-10)bounceAirTime+=dt;
 if(compression>0){
  // Sound starts on the descending landing, not the later upward reversal.
  // Require real airtime to avoid repeated boings from rotating contact edges.
  const landing=velocity>40&&bounceAirTime>=.06;
  const standingJump=bounceSoundArmed;
  if(landing||standingJump){
   if(typeof BounceAudio!=='undefined')BounceAudio.boing(Math.abs(velocity));
  }
  bounceSoundArmed=false;bounceAirTime=0;
 }
}
function step(dt){
 if(roundOver){updateGameOver(dt);return;}
 if(roomTransition){updateRoomTransition(dt);return;}
 if(opening.progress!==undefined)opening.progress=Math.min(1,opening.progress+dt/.5);
 simulationTime+=dt;
 // Exact exponential decay: the remaining pain halves every two active seconds.
 const recoveryDt=Math.min(dt,Math.max(0,simulationTime-lastDamageTime-P.recoveryDelay));
 health=100-(100-health)*Math.exp(-P.recoveryRate*recoveryDt);
 hitFlash=Math.max(0,hitFlash-dt);
 horizontalPosition+=horizontalSpeed*dt;
 // Exaggerated cartoon counter-rotation: lighter arms windmill against the torso.
 updateRotationControl(dt);
 updatePainRotation(dt);
 angularSpeed*=Math.exp(-P.spinDamping*dt);painSpinSpeed*=Math.exp(-P.spinDamping*dt);
 bodyAngle=(bodyAngle+angularSpeed*dt)%(Math.PI*2);
 armAngle=(armAngle-angularSpeed*4.4*dt)%(Math.PI*2);
 if(bedState().depth>0&&Math.abs(velocity)<25&&Math.abs(bedState().depth-P.gravity/P.spring)<8)pumped=false;
 const compression=bedState().depth,contact=compression>0;
 if(contact&&!trampolineContact)steerBounce();
 velocity+=(P.gravity-(contact?P.spring*compression+P.damping*velocity:0))*dt;y+=velocity*dt;
 const touchingBed=bedState().depth>0;
 if(touchingBed&&!contact&&!trampolineContact)steerBounce();
 trampolineContact=touchingBed;
 if(contact&&!touchingBed&&velocity<0){velocity=-Math.max(P.minLaunch,-velocity);pumped=false;bounceHeight=0;}
 if(y<surface){bounceHeight=Math.max(bounceHeight,surface-y);best=Math.max(best,bounceHeight);}
 updateBounceSound(dt);
 resolveCollisions();
 updateFacing();
 updateAnimation(dt);
 updateVomit(dt);
 updateBlood(dt);
 updateWallDrips(dt);
 squish=Math.max(0,squish-dt*3);feedbackTime=Math.max(0,feedbackTime-dt);}
// Secondary spring animation is visual only; head/foot collision anchors stay fixed.
// Small, short-lived red droplets for substantial new pain only.
function spawnBlood(nx,ny,painIncrement){
 const head=geometry().head;
 const x=Math.max(42,Math.min(858,head.x-nx*P.headRadius));
 const yHit=Math.max(87,Math.min(bedHeight(x)-2,head.y-ny*P.headRadius));
 const count=Math.min(18,8+Math.floor(painIncrement/2));
 for(let i=0;i<count&&bloodParticles.length<120;i++){
  const outward=45+vomitRandom()*120,tangent=(vomitRandom()-.5)*210;
  bloodParticles.push({x,y:yHit,vx:nx*outward-ny*tangent,vy:ny*outward+nx*tangent,
   life:1.4+vomitRandom()*1.2,radius:1.8+vomitRandom()*1.5,stuck:false,bed:false});
 }
}
function resetRoomFluids(){wallDrips=[];floorFluids={blood:new Float32Array(82),vomit:new Float32Array(82)};}
function floorSplat(mass,speed){if(typeof BounceAudio!=='undefined'&&BounceAudio.splat)BounceAudio.splat(mass,speed);}
function depositFluid(kind,x,mass){
 const bin=Math.max(0,Math.min(81,Math.floor((x-40)/10)));
 floorFluids[kind][bin]+=mass*.7;
 floorFluids[kind][Math.max(0,bin-1)]+=mass*.15;
 floorFluids[kind][Math.min(81,bin+1)]+=mass*.15;
}
function leaveWallDrop(kind,side,x,y,radius){
 const mass=radius*radius*.35;
 const nearby=wallDrips.find(d=>d.kind===kind&&d.side===side&&d.phase==='hanging'&&Math.abs(d.x-x)<15&&Math.abs(d.y-y)<25);
 if(nearby){nearby.mass+=mass;nearby.radius=Math.min(7,Math.sqrt(nearby.mass));return;}
 if(wallDrips.length>=160){depositFluid(kind,x,mass);return;}
 wallDrips.push({kind,side,x,y,startY:y,mass,radius:Math.max(2,radius*.7),phase:'hanging',age:0,delay:.18+vomitRandom()*.18,vx:0,vy:0});
}
function updateWallDrips(dt){
 for(const d of wallDrips){
  d.age+=dt;
  if(d.phase==='hanging'){
   if(d.age<d.delay)continue;
   d.phase='falling';d.x=Math.max(46,Math.min(854,d.x));
   d.vx=d.side==='left'?9:d.side==='right'?-9:(vomitRandom()-.5)*12;
  }
  // Detached drops accelerate under gravity instead of sliding down the wall.
  d.vy+=720*dt;d.x=Math.max(44,Math.min(856,d.x+d.vx*dt));d.y+=d.vy*dt;
  if(d.y+d.radius>=705){floorSplat(d.mass,d.vy);depositFluid(d.kind,d.x,d.mass);d.finished=true;}
 }
 wallDrips=wallDrips.filter(d=>!d.finished);
}
function updateFluidParticles(particles,kind,dt){
 for(const p of particles){
  if(p.onBed){
   p.y=bedHeight(p.x)-p.radius;p.bedTimer-=dt;
   if(p.bedTimer<=0){p.onBed=false;p.seep=true;p.y=bedHeight(p.x)+p.radius+2;}
   continue;
  }
  p.vy+=1000*dt;p.x+=p.vx*dt;p.y+=p.vy*dt;
  const fitsWall=p.y-p.radius>=opening.start&&p.y+p.radius<=opening.end;
  if(p.x-p.radius<40){
   if(opening.side==='left'&&fitsWall){p.finished=true;continue;}
   p.x=40+p.radius;leaveWallDrop(kind,'left',42,p.y,p.radius);
   p.vx=Math.abs(p.vx)*.55;p.vy*=.85;p.radius*=Math.sqrt(.65);
  }
  if(p.x+p.radius>860){
   if(opening.side==='right'&&fitsWall){p.finished=true;continue;}
   p.x=860-p.radius;leaveWallDrop(kind,'right',858,p.y,p.radius);
   p.vx=-Math.abs(p.vx)*.55;p.vy*=.85;p.radius*=Math.sqrt(.65);
  }
  if(p.y-p.radius<85){
   if(opening.side==='ceiling'&&p.x-p.radius>=opening.start&&p.x+p.radius<=opening.end){p.finished=true;continue;}
   p.y=85+p.radius;leaveWallDrop(kind,'ceiling',p.x,87,p.radius);
   p.vy=Math.abs(p.vy)*.55;p.vx*=.85;p.radius*=Math.sqrt(.65);
  }
  if(!p.seep&&p.y>=bedHeight(p.x)-p.radius&&p.vy>0){
   p.y=bedHeight(p.x)-p.radius;
   if(p.vy>100&&!p.bedBounced){p.vy=-p.vy*.3;p.vx*=.7;p.bedBounced=true;}
   else{p.onBed=true;p.bedTimer=.35;p.vx*=.4;}
  }
  if(p.y+p.radius>=705){
   if(!p.floorSoundPlayed){floorSplat(p.radius*p.radius,p.vy);p.floorSoundPlayed=true;}
   p.y=705-p.radius;
   if(p.vy>90&&!p.floorBounced){p.vy=-p.vy*.25;p.vx*=.4;p.floorBounced=true;}
   else{depositFluid(kind,p.x,p.radius*p.radius);p.finished=true;}
  }
 }
 return particles.filter(p=>!p.finished);
}
function drawFluidParticles(particles,kind){
 const color=kind==='blood'?'#d85050':'#b5d35a';
 ctx.save();ctx.lineCap='round';ctx.fillStyle=color;
 for(const p of particles){
  if(p.onBed){ctx.beginPath();ctx.ellipse(p.x,p.y,p.radius*1.8,p.radius*.45,0,0,Math.PI*2);ctx.fill();}
  else line([[p.x-p.vx*.012,p.y-p.vy*.012],[p.x,p.y]],color,Math.max(1,p.radius*1.2));
 }
 ctx.restore();
}
function drawAccumulatedFluids(){
 ctx.save();ctx.lineCap='round';
 for(const kind of ['vomit','blood']){
  const color=kind==='blood'?'#ef5559':'#c4e64d';ctx.fillStyle=color;
  for(let i=0;i<82;i++){
   const mass=floorFluids[kind][i];if(mass<=0)continue;
   const height=Math.min(44,4+Math.sqrt(mass)*1.7),x=45+i*10+(kind==='blood'?2:0);
   const spread=12+Math.min(12,Math.sqrt(mass)*.35);
   ctx.fillStyle=color;ctx.beginPath();ctx.ellipse(x,705-height*.5,spread,height*.5,0,0,Math.PI*2);ctx.fill();
   line([[x-spread*.35,705-height*.78],[x+spread*.25,705-height*.83]],kind==='blood'?'#ffac9f':'#edff9c',1.6);
  }
 }
 for(const d of wallDrips){
  const color=d.kind==='blood'?'#d85050':'#b5d35a';
  const stretch=d.phase==='hanging'?Math.min(9,d.age/d.delay*9):Math.min(16,d.vy*.025);
  ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(d.x,d.y-stretch-d.radius);
  ctx.quadraticCurveTo(d.x+d.radius*1.5,d.y+d.radius*.2,d.x+d.radius,d.y+d.radius);
  ctx.quadraticCurveTo(d.x,d.y+d.radius*2,d.x-d.radius,d.y+d.radius);
  ctx.quadraticCurveTo(d.x-d.radius*1.5,d.y+d.radius*.2,d.x,d.y-stretch-d.radius);ctx.fill();
 }
 ctx.restore();
}
function updateBlood(dt){bloodParticles=updateFluidParticles(bloodParticles,'blood',dt);}
function drawBlood(){drawFluidParticles(bloodParticles,'blood');}
// Cosmetic particles use their own random stream, preserving gameplay randomness.
function vomitRandom(){vomitSeed=(Math.imul(vomitSeed,1664525)+1013904223)>>>0;return vomitSeed/4294967296;}
function resetVomit(){nauseaTime=0;vomitAccumulator=0;vomiting=false;vomitParticles=[];vomitSeed=937;}
function updateVomit(dt){
 nauseaTime=Math.abs(angularSpeed)>P.vomitSpinThreshold?nauseaTime+dt:0;
 vomiting=nauseaTime>=P.vomitSpinDelay;
 if(vomiting){
  vomitAccumulator+=dt;
  while(vomitAccumulator>=1/40&&vomitParticles.length<100){
   vomitAccumulator-=1/40;
   const pose=characterPose(),c=Math.cos(bodyAngle),s=Math.sin(bodyAngle);
   const mx=pose.headX+faceSign()*P.headRadius,my=pose.head-pose.pivot+8*P.headRadius/13;
   const spray=bodyAngle+(faceSign()<0?Math.PI:0)+(vomitRandom()-.5)*.5,speed=210+vomitRandom()*120;
   vomitParticles.push({x:horizontalPosition+c*mx-s*my,y:pose.pivot+s*mx+c*my,
    vx:horizontalSpeed+Math.cos(spray)*speed,vy:velocity+Math.sin(spray)*speed,
    life:1.3+vomitRandom()*.7,radius:2.5+vomitRandom()*2.5,stuck:false});
  }
 }else vomitAccumulator=0;
 vomitParticles=updateFluidParticles(vomitParticles,'vomit',dt);
}
function drawVomit(){drawFluidParticles(vomitParticles,'vomit');}
function resetAnimation(){
 animation={bend:0,bendSpeed:0,lag:0,lagSpeed:0,tuck:0,tuckSpeed:0,recoil:0,recoilSpeed:0};
}
function updateAnimation(dt){
 const pain=(100-health)/100,depth=bedState().depth;
 const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
 const follow=(key,target,stiffness,damping)=>{
  const speed=key+'Speed';
  animation[speed]+=((target-animation[key])*stiffness-animation[speed]*damping)*dt;
  animation[key]+=animation[speed]*dt;
 };
 follow('bend',clamp(depth*.5+velocity*.023-angularSpeed*4+horizontalSpeed*.03+pain*Math.sin(simulationTime*16)*9,-38,42),110,12);
 follow('lag',clamp(-angularSpeed*5-velocity*.012,-30,30),65,8);
 follow('tuck',clamp(depth/48+Math.abs(angularSpeed)*.1+pain*.2,0,1),190,18);
 follow('recoil',hitFlash/.35,190,16);
}
function curve(start,control,end,color,width=3){
 ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(...start);ctx.quadraticCurveTo(...control,...end);ctx.stroke();
}
function drawCharacter(cx,depth){
 const pose=characterPose(),{pivot,hip,shoulder,shoulderX,head,headX}=pose;
 const pain=(100-health)/100,ink='#ecf0d9',back=ink;
 const {bend,lag,tuck,recoil}=animation;
 ctx.save();ctx.translate(cx,pivot);ctx.rotate(bodyAngle);ctx.translate(-cx,-pivot);
 ctx.lineCap='round';ctx.lineJoin='round';
 // Feet remain on their physical anchors while knees lag and fold around them.
 const farKnee=[cx+pose.farKnee[0],pose.farKnee[1]];
 const nearKnee=[cx+pose.nearKnee[0],pose.nearKnee[1]];
 line([[cx,hip],farKnee,[cx+13,y-2]],back,3.4);
 line([[cx,hip],nearKnee,[cx-8,y-2]],ink,4);
 line([[cx-8,y-2],[cx-2,y-1]],ink,3);
 line([[cx+13,y-2],[cx+19,y-1]],back,2.6);
 // Curved spine and neck make the fixed head and shoulder anchors feel elastic.
 curve([cx,hip],[cx+bend*1.25+recoil*14,hip-14],[cx+shoulderX,shoulder],ink,4);
 curve([cx+shoulderX,shoulder],[cx+headX+bend*.7-recoil*9,shoulder-10],[cx+headX,head+P.headRadius],ink,3);
 // Counter-rotating arms have separately folding elbows and trailing wrists.
 ctx.save();ctx.translate(cx+shoulderX,shoulder+7);ctx.rotate((ending?0:armAngle)-bodyAngle);
 const flail=pain*Math.sin(simulationTime*18)*.7;
 const arm=(side,color)=>{
  let upper=side*(.5+tuck*.8)+lag*.035+Math.sin(simulationTime*4)*.12+flail;
  if(ending)upper=side*.2+(side===1?-2.6*ending.raise:0);
  const elbow=[Math.sin(upper)*P.upperArmLength,Math.cos(upper)*P.upperArmLength];
  let fore=upper+side*(.65+tuck*1.9)+lag*.055+recoil*side*.9;
  if(ending)fore=side*.35+(side===1?-3.3*ending.raise:0);
  const hand=[elbow[0]+Math.sin(fore)*P.forearmLength,elbow[1]+Math.cos(fore)*P.forearmLength];
  line([[0,0],elbow,hand],color,side<0?2.8:3.3);
  ctx.fillStyle=color;ctx.beginPath();ctx.arc(...hand,2,0,Math.PI*2);ctx.fill();
 };
 arm(-1,back);arm(1,ink);ctx.restore();
 ctx.save();ctx.translate(cx+headX,head);ctx.scale(faceSign()*P.headRadius/13,P.headRadius/13);
 ctx.strokeStyle=hitFlash>0?'#ff967c':ink;ctx.lineWidth=3;
 ctx.beginPath();ctx.ellipse(0,0,13+recoil,13-recoil*1.5,-recoil*.15,0,Math.PI*2);ctx.stroke();
 line([[12,-2],[18,3],[12,5]],ink,2);
 drawFace(ink);
 ctx.restore();ctx.restore();
}
function facialExpression(){
 if(ending)return ending.newRecord&&(ending.phase==='rest'||ending.phase==='done')?'weak-grin':'dazed';
 if(hitFlash>.08||animation.recoil>.25)return 'hurt';
 if(vomiting)return 'sick';
 if(health<35)return 'dazed';
 if(simulationTime<victoryUntil)return 'victory';
 if(Math.abs(angularSpeed)>2.4)return 'worried';
 if(health<70)return 'sore';
 return 'happy';
}
function drawFace(ink){
 const expression=facialExpression();ctx.lineWidth=1.7;ctx.strokeStyle=ink;ctx.fillStyle=ink;
 const dot=(x,y,r=1.5)=>{ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();};
 if(expression==='dazed'){
  for(const x of [0,7]){line([[x-2,-6],[x+2,-2]],ink,1.8);line([[x+2,-6],[x-2,-2]],ink,1.8);}
 }else if(expression==='hurt'){
  line([[-3,-6],[1,-3],[-3,-1]],ink,1.8);line([[5,-6],[9,-3],[5,-1]],ink,1.8);
 }else if(expression==='worried'){
  for(const x of [0,7]){ctx.beginPath();ctx.arc(x,-4,3.1,0,Math.PI*2);ctx.stroke();dot(x+.6,-3.6,.95);}
  line([[-3,-9],[2,-10]],ink,1.5);line([[5,-10],[10,-8]],ink,1.5);
 }else if(expression==='victory'){
  curve([-3,-3],[0,-8],[3,-3],ink,1.8);curve([5,-3],[8,-8],[11,-3],ink,1.8);
 }else if(expression==='sick'||expression==='sore'||expression==='weak-grin'){
  line([[-3,-4],[3,-3]],ink,1.8);line([[5,-3],[10,-4]],ink,1.8);dot(0,-2.5,1);dot(7,-2.5,1);
 }else{dot(0,-3);dot(7,-3);}
 if(vomiting){ctx.fillStyle='#b5d35a';ctx.beginPath();ctx.ellipse(11,7,4.5,3.5,0,0,Math.PI*2);ctx.fill();}
 else if(expression==='hurt'){
  ctx.strokeRect(-2,4,12,5);for(const x of [1,4,7])line([[x,4],[x,9]],ink,1);
 }else if(expression==='dazed'){
  line([[-2,7],[1,5],[4,8],[7,5],[10,7]],ink,1.8);
 }else if(expression==='worried'){
  ctx.beginPath();ctx.ellipse(5,7,3.1,4.1,0,0,Math.PI*2);ctx.stroke();
 }else if(expression==='sore'||expression==='sick'){
  curve([-2,9],[4,2],[10,9],ink,1.8);
 }else if(expression==='weak-grin'){
  curve([0,6],[5,10],[10,5],ink,1.8);
 }else{
  curve([-2,4],[5,expression==='victory'?15:13],[11,4],ink,2);
  line([[-1,5],[10,5]],ink,1.2);
 }
}
function drawPainEffects(){
 const pain=Math.max(0,Math.min(1,(100-health)/100));
 if(pain<.01)return;
 const head=geometry().head,cx=head.x,cy=head.y-P.headRadius-8;
 const orbitX=P.headRadius+17+pain*9,orbitY=8+pain*7;
 const phase=simulationTime*(1.1+pain*5),count=Math.ceil(pain*6);
 ctx.save();ctx.lineCap='round';ctx.globalAlpha=Math.min(1,pain*5);
 // Two trailing arcs read as a dizzy halo without turning with the torso.
 ctx.strokeStyle='#d7e9ec';ctx.lineWidth=1.5;
 for(let i=0;i<2;i++){
  const start=phase+i*Math.PI;ctx.beginPath();ctx.ellipse(cx,cy,orbitX,orbitY,-.08,start,start+1.7);ctx.stroke();
 }
 for(let i=0;i<count;i++){
  const angle=phase+i*Math.PI*2/count;
  const x=cx+Math.cos(angle)*orbitX,yStar=cy+Math.sin(angle)*orbitY;
  const size=6+pain*4,spin=simulationTime*(2+pain*4)+i;
  ctx.fillStyle=i%2?'#fff4bb':'#ffd85f';ctx.beginPath();
  for(let j=0;j<10;j++){
   const a=spin+j*Math.PI/5-Math.PI/2,r=j%2?size*.43:size;
   const px=x+Math.cos(a)*r,py=yStar+Math.sin(a)*r;
   if(j===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);
  }
  ctx.closePath();ctx.fill();
 }
 // Small corkscrew swirls become more energetic as pain rises.
 if(pain>.2)for(let i=0;i<(pain>.65?3:2);i++){
  const side=i%2?-1:1,sx=cx+side*(orbitX+8),sy=cy-7-i*6;
  ctx.strokeStyle=i%2?'#ffd85f':'#d7e9ec';ctx.lineWidth=1.8;ctx.beginPath();
  for(let j=0;j<=28;j++){
   const t=j/28,a=t*Math.PI*3.5+phase*side,r=(2+pain*7)*t;
   const px=sx+Math.cos(a)*r,py=sy+Math.sin(a)*r*.75;
   if(j===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);
  }
  ctx.stroke();
 }
 ctx.restore();
}
function line(points,color,w=2){ctx.strokeStyle=color;ctx.lineWidth=w;ctx.beginPath();points.forEach(([a,b],i)=>i?ctx.lineTo(a,b):ctx.moveTo(a,b));ctx.stroke();}
function drawRoomBoundary(){
 const wall='#ffffff',glow='#f0d38b';
 const edge=(side,start,end)=>{
  const point=t=>side==='ceiling'?[t,85]:[side==='left'?40:860,t];
  if(opening.side===side){
   const gap=doorGap();
   line([point(start),point(gap.start)],wall);line([point(gap.end),point(end)],wall);
   // Thicker short panels make the sliding movement legible.
   line([point(opening.start),point(gap.start)],wall,5);line([point(gap.end),point(opening.end)],wall,5);
   const a=point(opening.start),b=point(opening.end);
   ctx.fillStyle='rgba(240,211,139,.1)';
   if(side==='ceiling'){ctx.fillRect(opening.start,65,opening.size,20);line([[a[0],75],[a[0],95]],glow,3);line([[b[0],75],[b[0],95]],glow,3);}
   else{const x=side==='left'?40:860;ctx.fillRect(x-10,opening.start,20,opening.size);line([[x-10,a[1]],[x+10,a[1]]],glow,3);line([[x-10,b[1]],[x+10,b[1]]],glow,3);}
   ctx.fillStyle=glow;ctx.font='11px Consolas,monospace';ctx.textAlign='center';
   if(side==='ceiling')ctx.fillText('EXIT ↑',(opening.start+opening.end)/2,76);
   else{ctx.save();ctx.translate(side==='left'?29:871,(opening.start+opening.end)/2);ctx.rotate(side==='left'?-Math.PI/2:Math.PI/2);ctx.fillText('EXIT ↑',0,0);ctx.restore();}
   ctx.textAlign='start';
  }else line([point(start),point(end)],wall);
 };
 edge('left',85,705);edge('right',85,705);edge('ceiling',40,860);line([[40,705],[860,705]],wall);
}
function draw(){ctx.clearRect(0,0,width,height);ctx.save();ctx.translate(ox,oy);ctx.scale(scale,scale);const cx=horizontalPosition,bed=bedState(),bedX=bed.position,depth=bed.depth;
 ctx.fillStyle='#15251c';ctx.fillRect(40,85,820,620);
 drawRoomBoundary();
 ctx.fillStyle='#0b160f';ctx.beginPath();ctx.ellipse(cx,690,135,9,0,0,Math.PI*2);ctx.fill();
 line([[40,590],[65,590]],'#ffffff',5);line([[825,590],[860,590]],'#ffffff',5);
 for(let i=0;i<15;i++){const t=i/14,x=40+t*820,d=depth*Math.sin(Math.PI*.5*(x<=bedX?(x-40)/(bedX-40):(860-x)/(860-bedX)));line([[x,591],[x+5,598+d*.35],[x-4,601+d*.7],[x,594+d]],'#ffffff',1.3);}
 ctx.strokeStyle='#ffffff';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(40,surface);ctx.quadraticCurveTo((40+bedX)/2,surface+depth*.12,bedX,surface+depth);ctx.quadraticCurveTo((bedX+860)/2,surface+depth*.12,860,surface);ctx.stroke();
 drawAccumulatedFluids();
 drawVomit();
 drawBlood();
 ctx.save();
 if(roomTransition){const distance=roomTransition.elapsed*400;ctx.translate(roomTransition.side==='left'?-distance:roomTransition.side==='right'?distance:0,roomTransition.side==='ceiling'?-distance:0);}
 drawCharacter(cx,depth);drawPainEffects();ctx.restore();
 ctx.restore();
 const seconds=Math.ceil(remainingMs/1000);
 ui.clock.textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
 ui.clock.style.color=seconds<=15?'#ff8d7b':'#e8eedc';
 ui.score.textContent=String(Math.max(0,roomNumber-1));ui.bestScore.textContent=String(bestScore);
 ui.room.textContent=`ROOM ${String(roomNumber).padStart(2,'0')}`;
 const painLevel=100-health;ui.health.textContent=Math.round(painLevel)+'%';ui.pain.textContent=painLevel<1?'Feeling fine':painLevel<40?'A little sore':painLevel<75?'That hurts!':'Ouch. Everything hurts.';
 ui.healthFill.style.width=painLevel+'%';ui.healthFill.style.background=health>60?'#bde68a':health>30?'#e8bd6c':'#ed806c';
 ui.healthBar.setAttribute('aria-valuenow',Math.round(painLevel));
 ui.height.textContent=(bounceHeight/100).toFixed(1)+' m';ui.best.textContent=(best/100).toFixed(1)+' m';const ready=depth>0&&!pumped&&timingScore()>.2;
 ui.phase.textContent=depth>0?(ready?'PUSH NOW':velocity>0?'STRETCHING':'SPRINGING BACK'):velocity>0?'FALLING':'RISING';ui.phase.style.color=ready?'#bde68a':'#8ea18f';ui.meter.style.width=Math.min(100,depth)+'%';ui.feedback.style.opacity=feedbackTime>0?'1':'0';}
function frame(time){updateRoundClock();if(!previous)previous=time;accumulator+=Math.min((time-previous)/1000,.05);previous=time;while(accumulator>=P.step){step(P.step);accumulator-=P.step;}draw();requestAnimationFrame(frame);}
// Mouse hover steers continuously. First touch steers; a second touch jumps.
function clearSteering(){gesture=null;touchPointers.clear();steeringTouchId=null;}
function selectTouchSteering(){
 if(!touchPointers.has(steeringTouchId))steeringTouchId=touchPointers.keys().next().value??null;
 const pointer=touchPointers.get(steeringTouchId);
 gesture=pointer?{kind:'touch',x:pointer.x}:null;
}
canvas.addEventListener('pointerdown',e=>{
 if(!startRound())return;
 if(e.pointerType==='mouse'){
  if(touchPointers.size||e.button!==0)return;
  e.preventDefault();gesture={kind:'mouse',x:e.clientX};pump();return;
 }
 e.preventDefault();canvas.setPointerCapture(e.pointerId);
 touchPointers.set(e.pointerId,{x:e.clientX});
 if(steeringTouchId===null){steeringTouchId=e.pointerId;selectTouchSteering();}
 else if(touchPointers.size===2)pump();
});
canvas.addEventListener('pointermove',e=>{
 if(!startRound())return;
 if(e.pointerType==='mouse'){
  if(!touchPointers.size)gesture={kind:'mouse',x:e.clientX};return;
 }
 if(!touchPointers.has(e.pointerId))return;
 e.preventDefault();touchPointers.set(e.pointerId,{x:e.clientX});selectTouchSteering();
});
function releaseTouch(e){
 if(e.pointerType==='mouse'||!touchPointers.has(e.pointerId))return;
 touchPointers.delete(e.pointerId);selectTouchSteering();
}
for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,releaseTouch);
canvas.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse'&&gesture?.kind==='mouse')gesture=null;});
addEventListener('blur',clearSteering);
addEventListener('keydown',e=>{if(e.code==='Space'){e.preventDefault();if(!e.repeat)pump();}if(e.code==='KeyR')reset();});document.getElementById('reset').addEventListener('click',reset);document.getElementById('playAgain').addEventListener('click',()=>{reset();startRound();});addEventListener('resize',resize);document.addEventListener('visibilitychange',()=>{previous=0;accumulator=0;clearSteering();});reset();resize();requestAnimationFrame(frame);







