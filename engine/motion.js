(function (root, factory) {
  const library = (typeof module === 'object' && module.exports) ? require('./etalons.js') : root.SpineEtalons;
  if (typeof module === 'object' && module.exports) module.exports = factory(library);
  else root.SpineMotion = factory(library);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (library) {
  'use strict';

  class MotionError extends Error { constructor(message) { super(message); this.name = 'MotionError'; } }
  const RAD = Math.PI / 180, DEG = 180 / Math.PI;
  const finite = (value, name) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new MotionError(name + ' must be finite');
    return value;
  };
  const angleDelta = angle => ((angle + 180) % 360 + 360) % 360 - 180;
  const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const point = (value, name) => {
    if (!value || typeof value !== 'object') throw new MotionError(name + ' is missing');
    return { x: finite(value.x, name + '.x'), y: finite(value.y, name + '.y') };
  };

  function setupTransforms(skeleton) {
    const transforms = new Map();
    for (const bone of skeleton.bones || []) {
      if (!bone || typeof bone.name !== 'string' || transforms.has(bone.name)) throw new MotionError('Unique named bones required');
      if (bone.inherit && !['normal', 'Normal'].includes(bone.inherit)) throw new MotionError('Shooting requires normal bone inheritance');
      const parent = bone.parent ? transforms.get(bone.parent) : { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
      if (!parent) throw new MotionError('Parent bones must precede children');
      const rotation = (bone.rotation || 0) * RAD;
      const sx = bone.scaleX === undefined ? 1 : bone.scaleX, sy = bone.scaleY === undefined ? 1 : bone.scaleY;
      if (bone.shearX || bone.shearY) throw new MotionError('Shooting arm setup does not support shear');
      const a = Math.cos(rotation) * sx, b = -Math.sin(rotation) * sy;
      const c = Math.sin(rotation) * sx, d = Math.cos(rotation) * sy;
      const x = bone.x || 0, y = bone.y || 0;
      transforms.set(bone.name, {
        a: parent.a * a + parent.b * c, b: parent.a * b + parent.b * d,
        c: parent.c * a + parent.d * c, d: parent.c * b + parent.d * d,
        x: parent.a * x + parent.b * y + parent.x, y: parent.c * x + parent.d * y + parent.y,
        angle: Math.atan2(parent.c * a + parent.d * c, parent.a * a + parent.b * c) * DEG
      });
    }
    return transforms;
  }

  function lowerAngle(arm, target) {
    const dx = target.x - arm.shoulder.x, dy = target.y - arm.shoulder.y;
    const rawDistance = Math.hypot(dx, dy);
    const distance = Math.max(Math.abs(arm.upperLength - arm.lowerLength) + 1e-5,
      Math.min(arm.upperLength + arm.lowerLength - 1e-5, rawDistance));
    const cosine = Math.max(-1, Math.min(1,
      (distance * distance - arm.upperLength ** 2 - arm.lowerLength ** 2) / (2 * arm.upperLength * arm.lowerLength)));
    const bend = (arm.bendPositive ? 1 : -1) * Math.acos(cosine);
    const upper = Math.atan2(dy, dx) - Math.atan2(arm.lowerLength * Math.sin(bend), arm.upperLength + arm.lowerLength * Math.cos(bend));
    return (upper + bend) * DEG;
  }

  function normalizeArm(skeleton, arm, side, transforms) {
    if (!arm || typeof arm !== 'object') throw new MotionError('Both arms need an IK rig: ' + side);
    const byName = new Map(skeleton.bones.map(b => [b.name, b]));
    const result = { side };
    for (const field of ['targetBone', 'upperBone', 'lowerBone', 'handBone', 'gunBone']) {
      if (typeof arm[field] !== 'string' || !byName.has(arm[field])) throw new MotionError(side + '.' + field + ' must name a real bone');
      result[field] = arm[field];
    }
    result.shoulder = point(arm.shoulderWorld, side + '.shoulderWorld');
    result.rest = point(arm.restTargetWorld, side + '.restTargetWorld');
    result.upperLength = finite(arm.upperLength, side + '.upperLength');
    result.lowerLength = finite(arm.lowerLength, side + '.lowerLength');
    if (result.upperLength <= 0 || result.lowerLength <= 0) throw new MotionError('Arm segment lengths must be positive');
    result.gunAxis = finite(arm.gunAxisWorldDegrees, side + '.gunAxisWorldDegrees');
    // Source PSDs with inferred joints have approximate pivots, not verified
    // anatomy. Constrain shooting motion so original silhouettes stay connected.
    result.pivotsInferred = arm.pivotsInferred === true;
    // Source-specific, independently verified artwork may explicitly opt into
    // a larger inferred-grip angular envelope. Default remains conservative
    // for all other PSDs. This alone NEVER certifies source/anatomical quality.
    const inferredLimit=arm.inferredAimTurnLimitDegrees;
    result.inferredAimTurnLimitDegrees=inferredLimit===undefined?14:
      finite(inferredLimit,side+'.inferredAimTurnLimitDegrees');
    if(result.inferredAimTurnLimitDegrees<14||result.inferredAimTurnLimitDegrees>45)
      throw new MotionError(side+' inferred aim limit must be between 14 and 45 degrees');
    const constraint = (skeleton.constraints || []).find(c => c.type === 'ik' && c.target === result.targetBone &&
      Array.isArray(c.bones) && c.bones.length === 2 && c.bones[0] === result.upperBone && c.bones[1] === result.lowerBone);
    if (!constraint) throw new MotionError(side + ' requires a real two-bone IK constraint');
    result.constraint = constraint;
    result.bendPositive = constraint.bendPositive !== false;
    if (arm.bendPositive !== undefined && !!arm.bendPositive !== result.bendPositive) throw new MotionError('IK bend direction differs from context');
    const target = byName.get(result.targetBone), parent = transforms.get(target.parent);
    if (!parent || Math.abs(parent.a - 1) > 1e-6 || Math.abs(parent.d - 1) > 1e-6 || Math.abs(parent.b) > 1e-6 || Math.abs(parent.c) > 1e-6)
      throw new MotionError('IK targets require an unscaled unrotated parent');
    const restTarget = transforms.get(result.targetBone);
    if (Math.hypot(restTarget.x - result.rest.x, restTarget.y - result.rest.y) > 1e-3)
      throw new MotionError('IK target context does not match exact setup pose');
    let ancestor = byName.get(result.gunBone), foundLower = false;
    while (ancestor) {
      if (ancestor.name === result.lowerBone) { foundLower = true; break; }
      ancestor = ancestor.parent ? byName.get(ancestor.parent) : null;
    }
    if (!foundLower || result.gunBone === result.lowerBone || result.gunBone === result.upperBone)
      throw new MotionError('Gun orientation bone must descend from the forearm');
    result.restLowerAngle = transforms.get(result.lowerBone).angle;
    result.solvedRestLowerAngle = lowerAngle(result, result.rest);
    return result;
  }

  const directions = { up: 90, down: -90, left: 180, right: 0, forward: 0 };
  const ACTIONS = new Set(['shoot', 'idle', 'walk', 'run', 'jump', 'wave', 'attack', 'hurt', 'death', 'dance', 'bow', 'reload', 'celebrate', 'crouch', 'look', 'turn', 'float', 'shake', 'nod', 'perform', 'cards_in', 'half_turn', 'hand_twitch', 'funny', 'cherry_idle', 'appear', 'burst']);
  const ETALON_ACTIONS = new Set(['cards_in', 'half_turn', 'hand_twitch', 'funny', 'cherry_idle', 'appear', 'burst']);

  function validatePlan(plan) {
    if (!plan || !Array.isArray(plan.clips) || plan.clips.length < 1 || plan.clips.length > 8)
      throw new MotionError('Plan must contain 1 to 8 clips');
    if (plan.clipCount !== undefined && plan.clipCount !== plan.clips.length) throw new MotionError('Clip count does not match plan');
    const names = new Set();
    for (const clip of plan.clips) {
      if (!clip || typeof clip.name !== 'string' || !clip.name.trim() || names.has(clip.name)) throw new MotionError('Each clip needs a unique name');
      names.add(clip.name);
      if (!ACTIONS.has(clip.action) && !(clip.action && /^[\p{L}\p{N}_-]{1,48}$/u.test(clip.action))) throw new MotionError('Unsupported motion action: ' + clip.action);
      finite(clip.duration, 'duration');
      if (clip.duration < 1 || clip.duration > 30) throw new MotionError('Duration must be between 1 and 30 seconds');
      if (clip.variant !== undefined && (!Number.isInteger(clip.variant) || clip.variant < 1 || clip.variant > 8)) throw new MotionError('variant must be 1 to 8');
      if (clip.action === 'shoot') {
        if (!Object.hasOwn(directions, clip.direction)) throw new MotionError('Unsupported shooting direction: ' + clip.direction);
        if (!Number.isInteger(clip.shotCount) || clip.shotCount < 1 || clip.shotCount > 4) throw new MotionError('shotCount must be 1 to 4');
        const recoil = clip.recoilScale === undefined ? 1 : finite(clip.recoilScale, 'recoilScale');
        if (recoil <= 0 || recoil > 3) throw new MotionError('recoilScale must be >0 and <=3');
      } else if (clip.direction != null && !Object.hasOwn(directions, clip.direction)) {
        throw new MotionError('Unsupported shooting direction: ' + clip.direction);
      }
    }
  }

  function shootingPose(arm, clip, phase) {
    const angle = directions[clip.direction], unit = { x: Math.cos(angle * RAD), y: Math.sin(angle * RAD) };
    const totalLength = arm.upperLength + arm.lowerLength;
    const minimumReach = Math.abs(arm.upperLength - arm.lowerLength);
    const aimDistance = Math.max(minimumReach + (totalLength - minimumReach) * .20,
      Math.min(totalLength * .94, totalLength * (clip.variant % 2 ? .77 : .83)));
    // An upward aim must use the OUTER shoulder lane. The original inward
    // perpendicular offset steered both wrists toward the head/sombrero.
    // Scope the correction to upward shots: other directions retain their
    // independently authored trajectories. Inferred joints still obey the
    // existing strict travel/rotation safety envelope below.
    const lateral = clip.direction === 'up'
      ? (arm.side === 'left' ? 1 : -1) * totalLength * .28
      : (arm.side === 'left' ? -1 : 1) * totalLength * .10;
    const aimTarget = { x: arm.shoulder.x + unit.x * aimDistance - unit.y * lateral,
      y: arm.shoulder.y + unit.y * aimDistance + unit.x * lateral };
    // A double-shot take needs its own *staged action*, not just two recoil
    // spikes over the same single-shot raise. A restrained backward wind-up,
    // delayed lift, rapid first shot and sustained second-shot sightline make
    // genuinely different silhouettes without adding images or touching setup.
    const stagedDouble = clip.shotCount >= 2 && clip.variant % 2 === 0;
    const isDoubleUpTake = stagedDouble && clip.direction === 'up';
    // Independently authored re-brace is a candidate, not artistic approval.
    const raiseStart = stagedDouble ? .14 : 0;
    // Complete the first aim before the native Editor frame-17 sightline gate;
    // the separate mid-shot re-brace remains at phases .41-.61.
    const raiseEnd = isDoubleUpTake ? .27 : (stagedDouble ? .34 : (clip.variant % 2 ? .30 : .25));
    const recoverStart = isDoubleUpTake ? .83 : (stagedDouble ? .79 : (clip.variant % 2 ? .67 : .60));
    let aim = phase <= raiseStart ? 0 :
      phase <= raiseEnd ? smooth((phase - raiseStart) / (raiseEnd - raiseStart)) :
      phase >= recoverStart ? 1 - smooth((phase - recoverStart) / (1 - recoverStart)) : 1;
    if (isDoubleUpTake && phase > .41 && phase < .61) {
      const middle = (phase - .41) / .20;
      // The single distinct re-brace is centred between shots and has
      // finished before the second aim hold and second shot; source pose is restored at 100%.
      aim *= 1 - .98 * Math.sin(Math.PI * middle) ** 2;
    }
    if (phase === 0 || phase === 1) aim = 0;
    // Wind-up finishes BEFORE the first shot and is zero at the endpoints.
    // Never use image/slot transforms: the grip, gun and fingers remain rigid.
    const anticipation = stagedDouble && phase > 0 && phase < .22
      ? Math.sin(Math.PI * phase / .22) ** 2 : 0;
    let recoil = 0;
    for (let shot = 0; shot < clip.shotCount; shot++) {
      const shotPhase = isDoubleUpTake ? .32 + .41 * shot / (clip.shotCount - 1)
        : clip.shotCount === 1 ? .50 : .40 + .26 * shot / (clip.shotCount - 1);
      const offset = clip.variant % 2 === 0 && arm.side === 'right' ? .025 : 0;
      const elapsed = phase - shotPhase - offset;
      const width = Math.min(.09, .22 / clip.shotCount);
      if (elapsed >= 0 && elapsed < width) {
        const pulse = elapsed / width;
        recoil += pulse < .18 ? smooth(pulse / .18) : 1 - smooth((pulse - .18) / .82);
      }
    }
    const amplitude = totalLength * .035 * (clip.recoilScale === undefined ? 1 : clip.recoilScale);
    // Interpolate around the shoulder in polar coordinates. A straight chord
    // from wrist to aim can cross the arm's unreachable inner circle, causing
    // the real IK solver to miss its target midway through a raise.
    const restDx = arm.rest.x - arm.shoulder.x, restDy = arm.rest.y - arm.shoulder.y;
    const aimDx = aimTarget.x - arm.shoulder.x, aimDy = aimTarget.y - arm.shoulder.y;
    const restRadius = Math.hypot(restDx, restDy), aimRadius = Math.hypot(aimDx, aimDy);
    const polarAngle = Math.atan2(restDy, restDx) + angleDelta((Math.atan2(aimDy, aimDx) - Math.atan2(restDy, restDx)) * DEG) * RAD * aim;
    const radius = restRadius + (aimRadius - restRadius) * aim;
    const target = { x: arm.shoulder.x + Math.cos(polarAngle) * radius,
      y: arm.shoulder.y + Math.sin(polarAngle) * radius };
    if (anticipation) {
      // An inward wind-up leaves the gun behind the firing line before the
      // double-shot pose. The gun, fingers, and hand share one IK wrist.
      const windup = Math.min(totalLength * .07, 8) * anticipation;
      target.x += (arm.side === 'left' ? 1 : -1) * windup * .65;
      target.y -= unit.y * windup;
    }
    if (arm.pivotsInferred) {
      // A source-aware raise may not consume the full travel budget: reserve
      // room for a separate short recoil pulse, otherwise clipping the final
      // wrist vector would erase the visible gunshot.
      const maxShift = Math.min(28, Math.min(arm.upperLength, arm.lowerLength) * .24);
      const maxAim = Math.max(maxShift * .6, maxShift - Math.min(amplitude, maxShift * .4));
      const dx = target.x - arm.rest.x, dy = target.y - arm.rest.y;
      const travel = Math.hypot(dx, dy);
      if (travel > maxAim) {
        target.x = arm.rest.x + dx * maxAim / travel;
        target.y = arm.rest.y + dy * maxAim / travel;
      }
    }
    target.x -= unit.x * amplitude * recoil;
    target.y -= unit.y * amplitude * recoil;
    const targetDx = target.x - arm.shoulder.x, targetDy = target.y - arm.shoulder.y;
    const targetRadius = Math.hypot(targetDx, targetDy);
    const safeRadius = Math.max(minimumReach + totalLength * .005, Math.min(totalLength * .995, targetRadius));
    if ((recoil > 0 || arm.pivotsInferred) && safeRadius !== targetRadius) {
      target.x = arm.shoulder.x + targetDx * safeRadius / targetRadius;
      target.y = arm.shoulder.y + targetDy * safeRadius / targetRadius;
    }
    // A completely immobile full-aim hold produces ten or more byte-identical
    // Editor PNGs despite a live clip. Give the supported wrist a restrained
    // breathing settle inside the held pose, rather than fake picture jitter.
    // It decays to zero at both hold boundaries and during a recoil accent.
    // This never changes setup pose, anatomy, source pixels or draw order.
    if (aim > .98 && recoil < .15 && phase > raiseEnd && phase < recoverStart) {
      const holdFraction = (phase - raiseEnd) / (recoverStart - raiseEnd);
      const envelope = Math.sin(Math.PI * holdFraction) ** 2;
      const settle = Math.sin(holdFraction * Math.PI * 4 +
        (clip.variant % 2 ? 0 : Math.PI / 5));
      const breath = envelope * settle * Math.min(1.4, totalLength * .012);
      target.x -= unit.x * breath;
      target.y -= unit.y * breath;
    }
    // Compensate the forearm rotation induced by IK. Translating a target alone
    // raises a hand but does not aim the weapon. This rotates the actual gun.
    const requestedTurn = angleDelta(angle - arm.gunAxis);
    // Artist-authored joints retain full aiming. Inferred joints need a
    // source-safe angular envelope to keep grip, sleeve and silhouette intact.
    // For an UPWARD shot a 14° inferred-axis turn looks like a near-horizontal
    // pistol, which is not the requested action (native evidence gate needs 26°).
    // Permit a bounded 30° raise ONLY for up-shots; the 28px wrist-travel,
    // shared hand/weapon parenting and the source setup remain unchanged.
    const maxInferredTurn = clip.direction === 'up'
      ? Math.max(30, arm.inferredAimTurnLimitDegrees) : arm.inferredAimTurnLimitDegrees;
    const safeTurn = arm.pivotsInferred
      ? Math.max(-maxInferredTurn, Math.min(maxInferredTurn, requestedTurn)) : requestedTurn;
    // A visible downward anticipation of up to 8 degrees also differentiates
    // the first shot's preparation; it vanishes before firing and at setup.
    const prePitch = anticipation * Math.min(8, Math.abs(safeTurn) * .25) *
      (safeTurn < 0 ? 1 : -1);
    const desiredAxis = arm.gunAxis + safeTurn * aim + prePitch +
      (arm.side === 'left' ? -1 : 1) * 4 * recoil;
    const lowerDelta = angleDelta(lowerAngle(arm, target) - arm.solvedRestLowerAngle);
    const rotation = phase === 0 || phase === 1 ? 0 : angleDelta(desiredAxis - arm.gunAxis - lowerDelta);
    return { x: phase === 0 || phase === 1 ? 0 : target.x - arm.rest.x,
      y: phase === 0 || phase === 1 ? 0 : target.y - arm.rest.y, rotation, aim, recoil, desiredAxis };
  }

  function motionSize(context) {
    const bounds = context && context.bounds;
    if (bounds && bounds.right > bounds.left && bounds.bottom > bounds.top) {
      return Math.max(80, Math.min(720, Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top)));
    }
    return 180;
  }
  function directionVector(direction) {
    const table = { up: { x: 0, y: 1 }, down: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, forward: { x: 1, y: 0 } };
    return table[direction] || { x: 0, y: 0 };
  }
  function rise(phase, start, end) {
    if (phase <= start) return 0;
    if (phase >= end) return 1;
    return smooth((phase - start) / (end - start));
  }
  function pulse(phase, from, to) {
    if (phase <= from || phase >= to) return 0;
    const local = (phase - from) / (to - from);
    return local < 0.5 ? smooth(local / 0.5) : 1 - smooth((local - 0.5) / 0.5);
  }

  function poseAt(clip, phase, size) {
    const amp = clip.intensity === undefined ? 1 : clip.intensity;
    const variant = clip.variant || 1;
    const dir = directionVector(clip.direction);
    const face = dir.x || 1;
    const pose = { x: 0, y: 0, rot: 0, sx: 1, sy: 1, head: 0, armX: 0, armY: 0, armMode: 'same' };
    switch (clip.action) {
      case 'idle': {
        const wave = Math.sin(phase * Math.PI * 2);
        pose.y = wave * size * 0.025 * amp;
        pose.sy = 1 + wave * 0.03 * amp;
        pose.sx = 1 - wave * 0.015 * amp;
        pose.head = wave * 4 * amp;
        pose.armY = wave * size * 0.012 * amp;
        break;
      }
      case 'walk': {
        const step = Math.sin(phase * Math.PI * 4);
        pose.y = Math.abs(step) * size * 0.035 * amp;
        pose.x = (dir.x || 0) * Math.sin(phase * Math.PI * 2) * size * 0.03 * amp;
        pose.rot = step * 4 * amp * face;
        pose.head = -step * 3 * amp;
        pose.armX = step * size * 0.07 * amp;
        pose.armMode = 'opposite';
        break;
      }
      case 'run': {
        const step = Math.sin(phase * Math.PI * 8);
        const env = Math.sin(phase * Math.PI);
        pose.y = Math.abs(step) * size * 0.055 * amp;
        pose.x = (dir.x || face) * Math.sin(phase * Math.PI * 2) * size * 0.045 * amp;
        pose.rot = face * 10 * env * amp + step * 3 * amp;
        pose.head = -face * 7 * env * amp;
        pose.armX = step * size * 0.1 * amp;
        pose.sy = 1 + step * 0.035 * amp;
        pose.armMode = 'opposite';
        break;
      }
      case 'jump': {
        const crouch = pulse(phase, 0, 0.2);
        const air = phase < 0.16 ? 0 : Math.sin(Math.min(1, (phase - 0.16) / 0.62) * Math.PI);
        const land = pulse(phase, 0.74, 0.96);
        pose.y = (-crouch * size * 0.05 + air * size * 0.26 - land * size * 0.045) * amp;
        pose.x = (dir.x || 0) * Math.sin(phase * Math.PI) * size * 0.07 * amp + (dir.y ? 0 : 0);
        pose.sy = 1 - crouch * 0.1 * amp - land * 0.12 * amp + air * 0.04 * amp;
        pose.sx = 1 + crouch * 0.07 * amp + land * 0.09 * amp;
        pose.armY = Math.max(0, air) * size * 0.08 * amp;
        pose.head = (dir.y || 0.2) * air * 10 * amp;
        break;
      }
      case 'wave': {
        const lift = Math.sin(phase * Math.PI);
        const flutter = Math.sin(phase * Math.PI * (6 + (variant % 3) * 2)) * lift;
        pose.armY = lift * size * 0.2 * amp;
        pose.armX = flutter * size * 0.05 * amp;
        pose.head = flutter * 8;
        pose.rot = lift * 5 * amp * face;
        pose.armMode = 'wave';
        break;
      }
      case 'attack': {
        const wind = pulse(phase, 0, 0.34);
        const strike = pulse(phase, 0.3, 0.58);
        const hit = strike - wind * 0.85;
        pose.x = dir.x * hit * size * 0.14 * amp + (dir.x ? 0 : hit * size * 0.1 * amp);
        pose.y = dir.y * hit * size * 0.12 * amp;
        pose.rot = hit * 16 * amp * face;
        pose.armX = Math.max(0, hit) * (dir.x || 1) * size * 0.16 * amp;
        pose.armY = Math.max(0, hit) * (dir.y || 0.15) * size * 0.12 * amp;
        pose.head = -hit * 8 * amp;
        pose.armMode = 'same';
        break;
      }
      case 'hurt': {
        const hit = phase < 0.14 ? smooth(phase / 0.14) : 1 - smooth((phase - 0.14) / 0.86);
        pose.x = -(dir.x || face) * hit * size * 0.1 * amp;
        pose.y = hit * size * 0.03 * amp;
        pose.rot = -hit * 14 * amp * face;
        pose.head = hit * 18 * amp;
        pose.sx = 1 - hit * 0.05 * amp;
        pose.sy = 1 + hit * 0.06 * amp;
        break;
      }
      case 'death': {
        const fall = rise(phase, 0.08, 0.72);
        pose.rot = fall * 76 * amp * face;
        pose.y = -fall * size * 0.2 * amp;
        pose.x = (dir.x || face) * fall * size * 0.1 * amp;
        pose.head = fall * 22 * amp;
        pose.armY = -fall * size * 0.05 * amp;
        break;
      }
      case 'dance': {
        const style = (variant - 1) % 3;
        const beats = style === 2 ? 3 : 2;
        const bounce = Math.sin(phase * Math.PI * 2 * beats);
        pose.y = Math.abs(bounce) * size * (0.045 + style * 0.018) * amp;
        pose.rot = Math.sin(phase * Math.PI * 2 * (style === 1 ? 1 : 2)) * (7 + style * 4) * amp;
        pose.x = Math.sin(phase * Math.PI * 4) * size * (style === 1 ? 0.06 : 0.03) * amp;
        pose.head = Math.sin(phase * Math.PI * 4) * 9 * amp;
        pose.armY = Math.max(0, bounce) * size * 0.1 * amp;
        pose.armX = Math.sin(phase * Math.PI * 2) * size * 0.08 * amp;
        pose.sy = 1 + bounce * 0.04 * amp;
        pose.armMode = style === 0 ? 'opposite' : 'same';
        break;
      }
      case 'bow': {
        const bow = pulse(phase, 0, 1) > 0 ? (phase < 0.4 ? smooth(phase / 0.4) : phase < 0.62 ? 1 : 1 - smooth((phase - 0.62) / 0.38)) : 0;
        pose.rot = bow * 26 * amp;
        pose.y = -bow * size * 0.05 * amp;
        pose.head = bow * 16 * amp;
        pose.armY = -bow * size * 0.03 * amp;
        break;
      }
      case 'reload': {
        const hold = phase < 0.28 ? smooth(phase / 0.28) : phase < 0.68 ? 1 : 1 - smooth((phase - 0.68) / 0.32);
        pose.armX = hold * size * 0.07 * amp;
        pose.armY = hold * size * 0.05 * amp;
        pose.y = -hold * size * 0.025 * amp;
        pose.head = -hold * 7 * amp;
        pose.armMode = 'inward';
        break;
      }
      case 'celebrate': {
        const env = Math.sin(phase * Math.PI);
        const hops = Math.abs(Math.sin(phase * Math.PI * 6));
        pose.y = hops * env * size * 0.09 * amp;
        pose.armY = env * size * 0.18 * amp;
        pose.rot = Math.sin(phase * Math.PI * 4) * 7 * amp;
        pose.head = Math.sin(phase * Math.PI * 8) * 6 * env * amp;
        pose.sy = 1 + hops * env * 0.05 * amp;
        pose.armMode = 'same';
        break;
      }
      case 'crouch': {
        const hold = phase < 0.24 ? smooth(phase / 0.24) : phase < 0.7 ? 1 : 1 - smooth((phase - 0.7) / 0.3);
        pose.y = -hold * size * 0.12 * amp;
        pose.sy = 1 - hold * 0.14 * amp;
        pose.sx = 1 + hold * 0.08 * amp;
        pose.head = hold * 8 * amp;
        break;
      }
      case 'look': {
        const hold = phase < 0.28 ? smooth(phase / 0.28) : phase < 0.72 ? 1 : 1 - smooth((phase - 0.72) / 0.28);
        const ang = (dir.x * -16) + (dir.y * 12);
        pose.head = (ang || 14) * hold * amp;
        pose.rot = pose.head * 0.2;
        break;
      }
      case 'turn': {
        const sweep = Math.sin(phase * Math.PI);
        pose.rot = (dir.x || face) * 24 * sweep * amp;
        pose.x = (dir.x || 0) * sweep * size * 0.04 * amp;
        pose.head = -pose.rot * 0.35;
        break;
      }
      case 'float': {
        pose.y = Math.sin(phase * Math.PI * 2) * size * 0.07 * amp;
        pose.x = (dir.x || 0) * Math.sin(phase * Math.PI * 2) * size * 0.04 * amp;
        pose.rot = Math.sin(phase * Math.PI * 2) * 6 * amp;
        pose.armY = Math.sin(phase * Math.PI * 2) * size * 0.04 * amp;
        break;
      }
      case 'shake': {
        const env = Math.sin(phase * Math.PI);
        pose.x = Math.sin(phase * Math.PI * 22) * env * size * 0.028 * amp;
        pose.y = Math.sin(phase * Math.PI * 18) * env * size * 0.018 * amp;
        pose.head = Math.sin(phase * Math.PI * 16) * env * 8 * amp;
        pose.rot = Math.sin(phase * Math.PI * 20) * env * 3 * amp;
        break;
      }
      case 'nod': {
        const beats = 2 + ((variant - 1) % 3);
        pose.head = Math.sin(phase * Math.PI * 2 * beats) * 14 * amp;
        pose.y = Math.sin(phase * Math.PI * 2 * beats) * size * 0.012 * amp;
        break;
      }
      default: {
        const seed = clip.seed || 1;
        const f1 = 1 + (seed % 4);
        const f2 = 1 + ((seed >>> 4) % 5);
        const signed = ((seed >>> 8) % 100) / 50 - 1;
        pose.y = Math.sin(phase * Math.PI * 2 * f1) * size * 0.06 * amp;
        pose.x = Math.sin(phase * Math.PI * 2 * f2) * size * 0.045 * amp * (signed || dir.x || 1);
        pose.rot = Math.sin(phase * Math.PI * 2 * f1) * (6 + (seed % 9)) * amp;
        pose.head = Math.sin(phase * Math.PI * 2 * f2) * 11 * amp;
        pose.armY = Math.sin(phase * Math.PI * 2 * f1) * size * 0.05 * amp;
        pose.armX = Math.sin(phase * Math.PI * 2 * f2) * size * 0.04 * amp;
        pose.armMode = seed % 2 ? 'opposite' : 'same';
        if (dir.y) pose.y += dir.y * Math.sin(phase * Math.PI) * size * 0.04 * amp;
      }
    }
    pose.sx = Math.max(0.72, Math.min(1.28, pose.sx));
    pose.sy = Math.max(0.72, Math.min(1.28, pose.sy));
    return pose;
  }

  function snap(value) { return Math.abs(value) < 1e-6 ? 0 : value; }

  function limbShift(arm, pose, clip) {
    const side = arm.side === 'left' ? -1 : 1;
    let weight = 1;
    let x = pose.armX;
    if (pose.armMode === 'opposite') x = pose.armX * side;
    else if (pose.armMode === 'inward') x = Math.abs(pose.armX) * -side;
    else if (pose.armMode === 'wave') {
      const focus = clip.direction === 'left' ? 'left' : clip.direction === 'right' ? 'right' : null;
      weight = !focus || arm.side === focus ? 1 : 0.25;
      x = pose.armX * (arm.side === 'left' ? -0.4 : 0.4);
    }
    const reach = arm.upperLength + arm.lowerLength;
    const limit = reach * 0.28;
    return {
      x: Math.max(-limit, Math.min(limit, x * weight)),
      y: Math.max(-limit, Math.min(limit, pose.armY * weight))
    };
  }

  function safeArmDelta(arm, offset) {
    const minR = Math.abs(arm.upperLength - arm.lowerLength) + reachPad(arm);
    const maxR = (arm.upperLength + arm.lowerLength) * 0.96;
    const tx = arm.rest.x + offset.x, ty = arm.rest.y + offset.y;
    const sx = tx - arm.shoulder.x, sy = ty - arm.shoulder.y;
    const radius = Math.hypot(sx, sy) || 1;
    const clamped = Math.max(minR, Math.min(maxR, radius));
    return {
      x: arm.shoulder.x + sx / radius * clamped - arm.rest.x,
      y: arm.shoulder.y + sy / radius * clamped - arm.rest.y
    };
  }
  function reachPad(arm) { return Math.max(1, (arm.upperLength + arm.lowerLength) * 0.02); }

  function pictureBones(skeleton) {
    return (skeleton.bones || []).filter(bone => bone && typeof bone.name === 'string' && /^b_/.test(bone.name));
  }

  // Prefer independent picture bones under root; fall back to any picture bone.
  function looseLayerBones(skeleton) {
    const all = pictureBones(skeleton);
    const underRoot = all.filter(bone => bone.parent === 'root');
    return underRoot.length ? underRoot : all;
  }

  // No layer is identified. A shot without an arm rig is one function of time,
  // with its own timing and reach on every picture bone. Names and roles are not read.
  function buildLooseShoot(skeleton, context, clip) {
    const frameCount = Math.max(60, Math.ceil(clip.duration * 30));
    const size = motionSize(context);
    const aim = directionVector(clip.direction || 'forward');
    const shots = clip.shotCount || 1;
    const recoilScale = clip.recoilScale === undefined ? 1 : clip.recoilScale;
    const animation = { bones: {} };
    const rootKeys = [];
    const layerKeys = [];
    for (let frame = 0; frame <= frameCount; frame++) {
      const phase = frame / frameCount;
      const time = frame === frameCount ? clip.duration : phase * clip.duration;
      const rest = phase === 0 || phase === 1;
      let recoil = 0;
      if (!rest) {
        for (let shot = 0; shot < shots; shot++) {
          const shotPhase = shots === 1 ? 0.5 : 0.4 + 0.26 * shot / (shots - 1);
          const elapsed = phase - shotPhase;
          const width = Math.min(0.09, 0.22 / shots);
          if (elapsed >= 0 && elapsed < width) {
            const pulse = elapsed / width;
            recoil += pulse < 0.18 ? smooth(pulse / 0.18) : 1 - smooth((pulse - 0.18) / 0.82);
          }
        }
      }
      const kick = size * 0.045 * recoilScale * recoil;
      const reach = size * 0.12;
      rootKeys.push({ time, x: snap(rest ? 0 : -aim.x * kick), y: snap(rest ? 0 : -aim.y * kick) });
      layerKeys.push({
        time,
        x: snap(rest ? 0 : aim.x * reach * (0.35 + recoil)),
        y: snap(rest ? 0 : aim.y * reach * (0.35 + recoil))
      });
    }
    if ((skeleton.bones || []).some(bone => bone.name === 'root')) animation.bones.root = { translate: rootKeys };
    const layers = looseLayerBones(skeleton);
    layers.forEach((bone, index) => {
      const count = Math.max(layers.length, 1);
      const phase = (index / count) * 0.12;
      const reachMul = 0.85 + (index % 5) * 0.06;
      const turn = index % 2 ? 1 : -1;
      animation.bones[bone.name] = {
        translate: layerKeys.map(key => ({
          time: key.time,
          x: snap(key.x * reachMul * (index % 3 === 0 ? turn : 1)),
          y: snap(key.y * reachMul)
        })),
        rotate: layerKeys.map(key => {
          const unit = clip.duration ? key.time / clip.duration : 0;
          const pulse = unit > 0 && unit < 1 ? Math.sin(unit * Math.PI) : 0;
          return { time: key.time, value: snap(turn * 4 * pulse * (0.4 + phase)) };
        })
      };
    });
    return animation;
  }

  function buildGeneralClip(skeleton, context, clip, arms) {
    const frameCount = Math.max(60, Math.ceil(clip.duration * 30));
    const size = motionSize(context);
    const returns = clip.action !== 'death';
    const animation = { bones: {} };
    const translate = [], rotate = [], scale = [];
    let headKeys = null;
    const named = new Set((skeleton.bones || []).map(bone => bone.name));
    const headName = context && context.headBone && named.has(context.headBone) ? context.headBone : null;
    for (let frame = 0; frame <= frameCount; frame++) {
      const phase = frame / frameCount;
      const time = frame === frameCount ? clip.duration : phase * clip.duration;
      const pose = poseAt(clip, phase, size);
      const rest = phase === 0 || (returns && phase === 1);
      const x = rest ? 0 : pose.x, y = rest ? 0 : pose.y, rot = rest ? 0 : pose.rot;
      translate.push({ time, x: snap(x), y: snap(y) });
      const previous = frame === 0 ? 0 : rotate[frame - 1].value;
      const value = frame === 0 ? 0 : previous + angleDelta(rot - previous);
      rotate.push({ time, value: snap(value) });
      scale.push({ time, x: snap(rest ? 1 : pose.sx), y: snap(rest ? 1 : pose.sy) });
      if (headName) {
        if (!headKeys) headKeys = [];
        const headPrev = frame === 0 ? 0 : headKeys[frame - 1].value;
        const head = rest ? 0 : pose.head;
        const headValue = frame === 0 ? 0 : headPrev + angleDelta(head - headPrev);
        headKeys.push({ time, value: snap(headValue) });
      }
    }
    // Each picture layer gets its own keys. They must not share one root curve
    // or the artwork looks merged into a single plate.
    const layers = looseLayerBones(skeleton);
    if (layers.length) {
      layers.forEach((bone, index) => {
        const count = Math.max(layers.length, 1);
        const lag = (index / count) * Math.min(0.14, clip.duration * 0.12);
        const amp = 0.75 + (index % 7) * 0.05;
        const turn = index % 2 ? 1 : -1;
        animation.bones[bone.name] = {
          translate: translate.map(key => {
            const unit = clip.duration ? key.time / clip.duration : 0;
            const wave = unit > 0 && unit < 1 ? Math.sin((unit + lag) * Math.PI) : 0;
            return {
              time: key.time,
              x: snap(key.x * amp + turn * size * 0.01 * wave),
              y: snap(key.y * amp)
            };
          }),
          rotate: rotate.map(key => {
            const unit = clip.duration ? key.time / clip.duration : 0;
            const wave = unit > 0 && unit < 1 ? Math.sin((unit + lag) * Math.PI) : 0;
            return { time: key.time, value: snap(key.value * amp + turn * 3 * wave) };
          }),
          scale: scale.map(key => ({ time: key.time, x: key.x, y: key.y }))
        };
      });
    } else if (named.has('root')) {
      animation.bones.root = { translate, rotate, scale };
    }
    if (headKeys && headName && !animation.bones[headName]) animation.bones[headName] = { rotate: headKeys };
    if (arms && arms.length) {
      for (const arm of arms) {
        const armKeys = [];
        for (let frame = 0; frame <= frameCount; frame++) {
          const phase = frame / frameCount;
          const time = frame === frameCount ? clip.duration : phase * clip.duration;
          const rest = phase === 0 || (returns && phase === 1);
          const pose = rest ? null : poseAt(clip, phase, size);
          const delta = rest ? { x: 0, y: 0 } : safeArmDelta(arm, limbShift(arm, pose, clip));
          armKeys.push({ time, x: snap(rest ? 0 : delta.x), y: snap(rest ? 0 : delta.y) });
        }
        animation.bones[arm.targetBone] = Object.assign(animation.bones[arm.targetBone] || {}, { translate: armKeys });
      }
    }
    return animation;
  }

  // A source PSD can draw a hat above the gun even when the gun later crosses
  // in front of the hat. Never rewrite the source setup slot list. For a fully
  // contiguous rigid pistol/finger group immediately underneath a hat slot,
  // lower ONLY that hat during the aimed portion of a shooting clip.
  // Refuse to guess when unrelated cards/particles occupy the intervening
  // slots: they must keep their intentional independent draw order.
  function protectiveDrawOrder(skeleton, context, clip, arms) {
    if (!Array.isArray(skeleton.slots) || !context?.layerBindings) return null;
    const names = skeleton.slots.map(slot => slot.name);
    const hats = names
      .map((name, index) => ({ name, index, binding: context.layerBindings[name] }))
      .filter(item => item.binding?.role === 'head' &&
        /sombrero|hat|шляп/i.test(item.name));
    for (const arm of arms) {
      const group = names
        .map((name, index) => ({ name, index, binding: context.layerBindings[name] }))
        .filter(item => item.binding?.parentBone === arm.handBone &&
          (item.binding.role === 'gun' || item.binding.role === 'finger'));
      if (group.length < 2 || !group.some(item => item.binding.role === 'gun') ||
          !group.some(item => item.binding.role === 'finger')) continue;
      const first = group[0].index, last = group[group.length - 1].index;
      if (last - first + 1 !== group.length) continue; // no interleaved cards
      const hat = hats.find(item => item.index === last + 1);
      if (!hat || first >= hat.index) continue;
      // Spine 4.3 draworder offsets are relative to setup slot indices.
      // Moving the adjacent hat down below the contiguous grip group preserves
      // the order of gun/fingers/front overlay and every unrelated layer.
      return [
        { time: 0 },
        { time: clip.duration * .12, offsets: [{ slot: hat.name, offset: first - hat.index }] },
        { time: clip.duration * .94 },
        { time: clip.duration }
      ];
    }
    return null;
  }

  function buildMotions(skeleton, context, plan) {
    if (!skeleton || !Array.isArray(skeleton.bones) || !Array.isArray(skeleton.constraints))
      throw new MotionError('A Spine 4.3 skeleton with constraints is required');
    if (!skeleton.skeleton || !/^4\.3\./.test(skeleton.skeleton.spine || '')) throw new MotionError('Spine 4.3 is required');
    validatePlan(plan);
    const transforms = setupTransforms(skeleton);
    const hasBoth = !!(context && context.arms && context.arms.left && context.arms.right);
    let arms = null;
    if (hasBoth) {
      arms = ['left', 'right'].map(side => normalizeArm(skeleton, context.arms[side], side, transforms));
      if (arms[0].targetBone === arms[1].targetBone || arms[0].gunBone === arms[1].gunBone)
        throw new MotionError('Two arms require separate targets and weapon orientation bones');
    }
    const animations = {};
    const rawArms = [];
    if (context && context.arms) {
      for (const side of ['left', 'right']) if (context.arms[side]) rawArms.push({ ...context.arms[side], side });
    }
    for (const clip of plan.clips) {
      if (ETALON_ACTIONS.has(clip.action)) {
        if (!library || !library.build) throw new MotionError('Pinned reference motions are missing');
        // Pure etalon curves only. No per-layer noise or derived keys on top.
        const etalon = library.build(skeleton, context, clip, rawArms, motionSize(context) / 400);
        animations[clip.name] = etalon;
        continue;
      }
      if (clip.action !== 'shoot') {
        animations[clip.name] = buildGeneralClip(skeleton, context, clip, arms);
        continue;
      }
      if (!arms) {
        animations[clip.name] = buildLooseShoot(skeleton, context, clip);
        continue;
      }
      const animation = { bones: {}, ik: {} };
      const frames = Math.max(60, Math.ceil(clip.duration * 30));
      for (const arm of arms) {
        const translate = [], rotate = [];
        for (let frame = 0; frame <= frames; frame++) {
          const phase = frame / frames, time = frame === frames ? clip.duration : phase * clip.duration;
          const pose = shootingPose(arm, clip, phase);
          translate.push({ time, x: pose.x, y: pose.y });
          // Keep angles continuous across +/-180. Equivalent wrapped angles
          // on adjacent keys otherwise interpolate through a full unwanted spin.
          const rotation = frame === 0 ? 0 : rotate[frame - 1].value + angleDelta(pose.rotation - rotate[frame - 1].value);
          rotate.push({ time, value: Math.abs(rotation) < 1e-10 ? 0 : rotation });
        }
        animation.bones[arm.targetBone] = { translate };
        // Rotate the hand/wrist assembly, never only the weapon picture.
        // The weapon, grip fingers and front overlay must share one rigid
        // transform, otherwise an aimed gun drifts away from the hand.
        // Target IK still translates/poses the full two-bone arm.
        const rigidGripBone = arm.handBone;
        animation.bones[rigidGripBone] =
          Object.assign(animation.bones[rigidGripBone] || {}, { rotate });
        const constraint = arm.constraint;
        const setupMix = constraint.mix === undefined ? 1 : constraint.mix;
        // Exact setup at frame zero; enable solving during the raise if the
        // incoming rig intentionally stores an inactive setup constraint.
        animation.ik[constraint.name] = [
          { time: 0, mix: setupMix, softness: constraint.softness || 0, bendPositive: constraint.bendPositive !== false,
            compress: !!constraint.compress, stretch: !!constraint.stretch },
          { time: clip.duration * .12, mix: 1, softness: 0, bendPositive: constraint.bendPositive !== false, compress: false, stretch: false },
          { time: clip.duration * .88, mix: 1, softness: 0, bendPositive: constraint.bendPositive !== false, compress: false, stretch: false },
          { time: clip.duration, mix: setupMix, softness: constraint.softness || 0, bendPositive: constraint.bendPositive !== false,
            compress: !!constraint.compress, stretch: !!constraint.stretch }
        ];
      }
      const protectedOrder = protectiveDrawOrder(skeleton, context, clip, arms);
      if (protectedOrder) animation.drawOrder = protectedOrder;
      // The source-wide cyan glow belongs to an effects root, not a moving
      // hand. During raised-arm IK poses a fully opaque diffuse image becomes a
      // visibly detached cyan plate. Fade only the broad *global* glow layer:
      // hand glow layers stay on their respective IK wrists unchanged.
      // Alpha timelines do not alter source PNG pixels, draw order or setup.
      const ambientGlow = (context?.glowSlotNames || []).filter(slotName => {
        const binding = context.layerBindings?.[slotName];
        return binding?.role === 'effect' && binding.parentBone === 'effects_root' &&
          /^glow(?:[-_]global)?$/i.test(slotName);
      });
      if (ambientGlow.length) {
        const duration = clip.duration;
        animation.slots ||= {};
        for (const slotName of ambientGlow) {
          animation.slots[slotName] = {
            alpha: [
              {time:0, value:1},
              {time:duration*0.12, value:.65},
              {time:duration*0.25, value:.12},
              {time:duration*0.72, value:.12},
              {time:duration*0.90, value:.65},
              {time:duration, value:1}
            ]
          };
        }
      }
      // The source keeps two separate hand glow attachments which can become
      // giant hard-edged opaque cyan regions in Editor exports. Dim the known
      // hand glows only during the raised aiming interval; never change source
      // rasters, setup slot colors, attachment order or the original end pose.
      const handGlows = (context?.glowSlotNames || []).filter(name =>
        /^(?:glow[-_]hand|glow[-_]hand[-_]right)$/i.test(name) &&
        skeleton.slots.some(slot => slot.name === name));
      for (const name of handGlows) {
        const slot = skeleton.slots.find(s => s.name === name);
        const setupColor = slot.color || 'FFFFFFFF';
        if (!/^[0-9a-fA-F]{8}$/.test(setupColor))
          throw new MotionError('Invalid glow slot source color: ' + name);
        const setupAlpha = parseInt(setupColor.slice(6), 16) / 255;
        const dimmed = setupAlpha * .20;
        (animation.slots ||= {})[name] = { alpha: [
          {time:0, value:setupAlpha},
          {time:clip.duration * .27, value:dimmed},
          {time:clip.duration * (clip.shotCount>1 ? .83 : .70), value:dimmed},
          {time:clip.duration * (clip.shotCount>1 ? .97 : .93), value:setupAlpha},
          {time:clip.duration, value:setupAlpha}
        ]};
      }
      // A broad cyan hand glow is part of the source PSD, not a separate
      // generated muzzle-flash sprite. A source-specific, larger wrist turn
      // exposes its opaque untextured plate across the face/arm silhouette.
      // Preserve original source PNGs and setup; cross-fade ONLY the actual
      // moving left-hand effect while the explicitly reviewed arm aims.
      // Default 14-degree inferred rigs and the right-hand glow are untouched.
      if (context?.arms?.left?.inferredAimTurnLimitDegrees>14) {
        for(const slotName of context.glowSlotNames||[]) {
          const binding=context.layerBindings?.[slotName];
          if(binding?.role!=='handEffect'||binding.side!=='left'||
             binding.parentBone!==context.arms.left.handBone)continue;
          animation.slots ||= {};
          animation.slots[slotName]={
            alpha:[
              {time:0,value:1},
              {time:clip.duration*.12,value:.7},
              {time:clip.duration*.25,value:.16},
              {time:clip.duration*.72,value:.16},
              {time:clip.duration*.90,value:.7},
              {time:clip.duration,value:1}
            ]
          };
        }
      }
      animations[clip.name] = animation;
    }
    return animations;
  }

  return { MotionError, buildMotions, setupTransforms, shootingPose };
});
