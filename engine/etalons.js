/* Pinned reference motions. They stay in generation and new references are added beside them. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpineEtalons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PINNED = [
    { id: 'shoot', title: 'Выстрел', action: 'shoot' },
    { id: 'cards_in', title: 'Карты внутрь', action: 'cards_in' },
    { id: 'half_turn', title: 'Полуоборот', action: 'half_turn' },
    { id: 'hand_twitch', title: 'Кисть', action: 'hand_twitch' },
    { id: 'funny', title: 'Смешная', action: 'funny' },
    { id: 'cherry_idle', title: 'Cherry idle', action: 'cherry_idle' },
    { id: 'appear', title: 'Appear', action: 'appear' },
    { id: 'burst', title: 'Burst', action: 'burst' }
  ];

  // Longer phrases first. A rewrite token is what the matcher sees; the curves below stay.
  const PHRASES = [
    { token: 'cardsin', pattern: /карты\s+внутрь|карты\s+в\s+руку|карти\s+всередину|карти\s+в\s+руку|cards?\s+in|каскад\s+карт\p{L}*/gu },
    { token: 'halfturn', pattern: /полуоборот\p{L}*|півповорот\p{L}*|half[\s-]*turn/gu },
    { token: 'handtwitch', pattern: /hand[\s-]*twitch|под[её]ргиван\p{L}*\s+кист\p{L}*|д[её]рган\p{L}*\s+кист\p{L}*|сіпанн\p{L}*\s+кист\p{L}*/gu },
    { token: 'funnyetalon', pattern: /смешн\p{L}*|смішн\p{L}*|комичн\p{L}*|комічн\p{L}*|(?<![\p{L}])funny(?![\p{L}])/gu },
    { token: 'cherryidle', pattern: /cherry[\s-]*idle|вишня[\s-]*idle|idle[\s-]*вишни|fx[\s-]*idle|cherry\s+дыхани\p{L}*/gu },
    { token: 'appearfx', pattern: /(?<![\p{L}])appear(?![\p{L}])|появлен\p{L}*|з['ʼ]явлен\p{L}*|поява\p{L}*|cherry[\s-]*appear|scale[\s-]*in/gu },
    { token: 'burstfx', pattern: /(?<![\p{L}])burst(?![\p{L}])|взрыв\p{L}*|вибух\p{L}*|explosion|cherry[\s-]*burst|праздничн\p{L}*\s+взрыв/gu }
  ];

  function applyPhrases(normalized) {
    let text = String(normalized);
    for (const phrase of PHRASES) {
      const flags = phrase.pattern.flags.includes('g') ? phrase.pattern.flags : phrase.pattern.flags + 'g';
      text = text.replace(new RegExp(phrase.pattern.source, flags), ' ' + phrase.token + ' ');
    }
    return text;
  }

  const snap = value => Math.round(Number(value) * 10000) / 10000;

  function dedupe(keys, duration, rest) {
    keys.sort((a, b) => a.time - b.time);
    const out = [];
    for (const key of keys) {
      if (out.length && Math.abs(out[out.length - 1].time - key.time) < 1e-4) out[out.length - 1] = key;
      else out.push(key);
    }
    out[0] = { ...rest, time: 0 };
    out[out.length - 1] = { ...rest, time: duration };
    return out;
  }

  function channel(mids, duration, kind) {
    const rest = kind === 'scale' ? { x: 1, y: 1 } : kind === 'rotate' ? { value: 0 } : { x: 0, y: 0 };
    const keys = [{ ...rest, time: 0 }];
    for (const mid of mids) {
      const time = Math.min(Math.max(+mid[0], 0.001), duration - 0.001);
      if (kind === 'rotate') keys.push({ time: snap(time), value: snap(mid[1]) });
      else if (kind === 'scale') keys.push({ time: snap(time), x: snap(mid[1]), y: snap(mid[2] != null ? mid[2] : mid[1]) });
      else keys.push({ time: snap(time), x: snap(mid[1]), y: snap(mid[2] || 0) });
    }
    keys.push({ ...rest, time: duration });
    return dedupe(keys, duration, rest);
  }

  function retimed(keys, authored, duration) {
    if (!keys || !keys.length) return keys;
    const src = Math.max(0.001, authored || duration);
    if (Math.abs(src - duration) < 1e-6) return keys;
    return keys.map(key => ({ ...key, time: snap(key.time * (duration / src)) }));
  }

  function pickBone(named, candidates) {
    const list = [...named];
    // Resolve each candidate fully (exact, then b_ prefix, then shortest contains) before the next.
    for (const name of candidates) {
      if (!name) continue;
      if (named.has(name)) return name;
      const lower = String(name).toLowerCase();
      const exact = list.find(b => String(b).toLowerCase() === lower);
      if (exact) return exact;
      const under = list.find(b => {
        const s = String(b).toLowerCase();
        return s === 'b_' + lower || s.endsWith('_' + lower);
      });
      if (under) return under;
      const hits = list.filter(b => String(b).toLowerCase().includes(lower))
        .sort((a, b) => String(a).length - String(b).length);
      if (hits.length) return hits[0];
    }
    return null;
  }

  function particleBones(named) {
    const list = [];
    for (let i = 0; i < 16; i++) {
      const name = 'p' + i;
      if (named.has(name)) list.push(name);
    }
    return list;
  }

  function build(skeleton, context, clip, arms, unit) {
    const scale = unit > 0 ? unit : 1;
    const named = new Set((skeleton.bones || []).map(bone => bone.name));
    const animation = { bones: {} };
    const face = clip.action === 'half_turn' && clip.direction === 'right' ? -1 : 1;
    const put = (bone, kind, mids, authored) => {
      if (!bone || !named.has(bone)) return;
      const duration = clip.duration;
      const keys = retimed(channel(mids, authored || duration, kind), authored || duration, duration);
      if (!animation.bones[bone]) animation.bones[bone] = {};
      animation.bones[bone][kind] = keys;
    };
    const left = (arms || []).find(arm => arm.side === 'left');
    const right = (arms || []).find(arm => arm.side === 'right');
    const body = context && named.has(context.bodyBone) ? context.bodyBone : (named.has('body') ? 'body' : null);
    const head = context && context.headBone && named.has(context.headBone) ? context.headBone : null;
    const cards = ((context && context.cardBones) || []).filter(name => named.has(name));
    const glows = ((context && context.glowBones) || []).filter(name => named.has(name));

    const cherry = pickBone(named, ['cherry', 'body', body].filter(Boolean));
    const frame = pickBone(named, ['frame', 'root']);
    const glow = pickBone(named, ['glow', ...(glows || [])]);
    const star = pickBone(named, ['star']);
    const star2 = pickBone(named, ['star2']);
    const particles = particleBones(named);

    if (clip.action === 'cards_in') {
      const duration = 1.6;
      cards.forEach((bone, index) => {
        const count = Math.max(cards.length, 1);
        const angle = (index / count) * Math.PI * 2;
        const ox = Math.cos(angle) * (120 + (index % 5) * 20);
        const oy = Math.sin(angle) * (120 + (index % 5) * 20) + 40;
        const start = 0.05 + index * 0.03;
        const turn = index % 2 ? 1 : -1;
        put(bone, 'translate', [[start, ox, oy], [0.55, ox * 0.35, oy * 0.25], [1.1, ox * 0.08, oy * 0.05], [1.45, 0, 0]], duration);
        put(bone, 'rotate', [[start, turn * 40], [0.9, turn * 8], [1.4, 0]], duration);
        put(bone, 'scale', [[start, 0.2, 0.2], [0.35, 1.15, 1.15], [1.0, 1.0, 1.0]], duration);
      });
      if (body) put(body, 'translate', [[0.4, 0, -6], [0.9, 0, 2]], duration);
      if (head) put(head, 'rotate', [[0.35, -6], [0.85, 4]], duration);
    } else if (clip.action === 'half_turn') {
      const duration = 1.8;
      if (body) {
        put(body, 'rotate', [[0.35, face * 25], [0.9, face * 90], [1.4, face * 175], [1.75, face * 180]], duration);
        put(body, 'translate', [[0.4, face * 8, 0], [1.0, face * 4, 0]], duration);
      }
      if (head) put(head, 'rotate', [[0.3, face * -12], [0.8, face * 20], [1.4, face * -8]], duration);
      cards.forEach((bone, index) => {
        const lag = 0.08 + (index % 4) * 0.02;
        put(bone, 'rotate', [[0.3 + lag, face * 30], [1.0 + lag, face * 160]], duration);
        put(bone, 'translate', [[0.4 + lag, face * 15, 10], [1.1 + lag, face * -5, 0]], duration);
      });
    } else if (clip.action === 'hand_twitch') {
      const duration = 1.2;
      const hand = right || left;
      if (hand) {
        put(hand.targetBone, 'translate', [[0.15, 4, 2], [0.3, -3, 1], [0.45, 5, -1], [0.6, -2, 2], [0.8, 3, 0]], duration);
        put(hand.targetBone, 'rotate', [[0.2, 8], [0.4, -10], [0.65, 6], [0.9, -4]], duration);
      }
      cards.forEach((bone, index) => {
        const turn = index % 2 ? 1 : -1;
        const lag = index * 0.02;
        put(bone, 'rotate', [[0.2 + lag, turn * 6], [0.5 + lag, turn * -5]], duration);
      });
    } else if (clip.action === 'funny') {
      const duration = 2;
      if (body) {
        put(body, 'translate', [[0.25, 0, 12], [0.5, 0, -4], [0.75, 0, 10], [1.1, 0, -2], [1.5, 0, 6]], duration);
        put(body, 'rotate', [[0.3, -8], [0.6, 10], [1.0, -6], [1.4, 5]], duration);
        put(body, 'scale', [[0.35, 1.05, 0.95], [0.7, 0.96, 1.04], [1.2, 1.03, 0.98]], duration);
      }
      if (head) {
        put(head, 'rotate', [[0.3, -12], [0.7, 15], [1.2, -10], [1.6, 8]], duration);
        put(head, 'scale', [[0.5, 1.05, 1.05], [1.0, 0.98, 0.98], [1.5, 1.04, 1.04]], duration);
      }
      if (left) put(left.targetBone, 'translate', [[0.4, -20, 25], [0.9, 10, 5], [1.4, -15, 20]], duration);
      if (right) put(right.targetBone, 'translate', [[0.35, 25, 20], [0.8, -10, 8], [1.3, 30, 15]], duration);
      cards.forEach((bone, index) => {
        const amp = 25 + (index % 6) * 8;
        const phase = (index % 8) * 0.08;
        const turn = index % 2 ? 1 : -1;
        put(bone, 'translate', [[0.25 + phase, turn * 15, amp], [0.55 + phase, turn * -10, amp * 0.3], [0.9 + phase, turn * 12, amp * 0.9], [1.3 + phase, 0, amp * 0.2]], duration);
        put(bone, 'rotate', [[0.4 + phase, turn * 25], [1.0 + phase, turn * -20]], duration);
        put(bone, 'scale', [[0.4 + phase, 1.15, 1.15], [0.9 + phase, 0.9, 0.9]], duration);
      });
      glows.forEach(bone => put(bone, 'scale', [[0.4, 1.3, 1.3], [1.0, 0.9, 0.9], [1.5, 1.2, 1.2]], duration));
    
} else if (clip.action === 'cherry_idle' || clip.action === 'appear' || clip.action === 'burst') {
      /* Exact Cherry FX v2 curves (from etalon pack). Retarget onto current bones. */
      const cherryApi = (typeof globalThis !== 'undefined' && globalThis.SpineCherryEtalon)
        || (typeof window !== 'undefined' && window.SpineCherryEtalon)
        || null;
      const map = { cherry_idle: 'idle', appear: 'appear', burst: 'burst' };
      const srcName = map[clip.action];
      const srcAnim = cherryApi && cherryApi.DATA && cherryApi.DATA.animations
        ? cherryApi.DATA.animations[srcName]
        : null;
      if (srcAnim && srcAnim.bones) {
        const authored = srcName === 'idle' ? 1.2 : srcName === 'appear' ? 0.7 : 1.0;
        const duration = clip.duration || authored;
        const timeScale = duration / authored;
        const find = (want) => {
          if (named.has(want)) return want;
          const lower = String(want).toLowerCase();
          for (const b of named) if (String(b).toLowerCase() === lower) return b;
          for (const b of named) {
            const s = String(b).toLowerCase();
            if (s === 'b_' + lower || s.endsWith('_' + lower)) return b;
          }
          let best = null, bestLen = 1e9;
          for (const b of named) {
            const s = String(b).toLowerCase();
            if (s.includes(lower) && s.length < bestLen) { best = b; bestLen = s.length; }
          }
          return best;
        };
        for (const [srcBone, channels] of Object.entries(srcAnim.bones)) {
          const dst = find(srcBone);
          if (!dst) continue;
          const copy = {};
          for (const [kind, keys] of Object.entries(channels)) {
            if (!Array.isArray(keys)) continue;
            copy[kind] = keys.map(k => {
              const out = { ...k, time: snap((k.time || 0) * timeScale) };
              return out;
            });
          }
          animation.bones[dst] = copy;
        }
      } else if (clip.action === 'cherry_idle') {
        const duration = 1.2;
        if (frame) put(frame, 'scale', [[0.6, 1.02, 1.02]], duration);
        if (cherry) {
          put(cherry, 'scale', [[0.4, 1.06, 1.06], [0.8, 0.98, 0.98]], duration);
          put(cherry, 'rotate', [[0.6, 4]], duration);
          put(cherry, 'translate', [[0.6, 0, 6 * scale]], duration);
        }
        if (glow) put(glow, 'scale', [[0.5, 1.18, 1.18]], duration);
        if (star) {
          put(star, 'scale', [[0.3, 1.2, 1.2], [0.6, 0.4, 0.4], [0.9, 1.0, 1.0], [1.15, 0.3, 0.3]], duration);
          put(star, 'rotate', [[1.15, 90]], duration);
        }
        if (star2) {
          put(star2, 'scale', [[0.4, 0.9, 0.9], [0.8, 0.3, 0.3], [1.15, 0.2, 0.2]], duration);
          put(star2, 'rotate', [[1.15, -70]], duration);
        }
        particles.forEach(bone => put(bone, 'scale', [[0.01, 0, 0]], duration));
      } else if (clip.action === 'appear') {
        const duration = 0.7;
        if (frame) put(frame, 'scale', [[0.01, 0.6, 0.6], [0.25, 1.08, 1.08], [0.5, 0.98, 0.98]], duration);
        if (cherry) {
          put(cherry, 'scale', [[0.01, 0.1, 0.1], [0.15, 1.25, 1.25], [0.35, 0.92, 0.92]], duration);
          put(cherry, 'rotate', [[0.01, -25], [0.25, 8]], duration);
          put(cherry, 'translate', [[0.01, 0, -40 * scale], [0.2, 0, 12 * scale]], duration);
        }
        if (glow) put(glow, 'scale', [[0.01, 0.2, 0.2], [0.2, 1.6, 1.6], [0.5, 1.1, 1.1]], duration);
        if (star) {
          put(star, 'scale', [[0.01, 0, 0], [0.15, 1.5, 1.5], [0.35, 0.8, 0.8], [0.55, 1.2, 1.2], [0.65, 0.6, 0.6]], duration);
          put(star, 'rotate', [[0.65, 120]], duration);
        }
        if (star2) {
          put(star2, 'scale', [[0.01, 0, 0], [0.2, 1.3, 1.3], [0.4, 0.5, 0.5], [0.65, 0.3, 0.3]], duration);
          put(star2, 'rotate', [[0.65, -100]], duration);
        }
        const dirs = [[96, 4], [120, 80], [50, 83], [14, 108], [-66, 169], [-181, 91], [-181, -14], [-140, -106], [-100, -219], [-23, -156], [70, -90], [110, -30]];
        particles.forEach((bone, index) => {
          const [tx, ty] = dirs[index % dirs.length];
          const lag = (index % 6) * 0.02;
          put(bone, 'translate', [[0.08 + lag, 0, 0], [0.25 + lag, tx * 0.4 * scale, ty * 0.4 * scale], [0.55, tx * scale, ty * scale]], duration);
          put(bone, 'scale', [[0.08 + lag, 0, 0], [0.2 + lag, 1.3, 1.3], [0.45, 0.8, 0.8], [0.65, 0, 0]], duration);
          put(bone, 'rotate', [[0.65, (index % 2 ? 1 : -1) * (60 + index * 17)]], duration);
        });
      } else if (clip.action === 'burst') {
        const duration = 1.0;
        if (frame) put(frame, 'scale', [[0.08, 1.12, 1.12], [0.2, 0.94, 0.94], [0.45, 1.04, 1.04]], duration);
        if (cherry) {
          put(cherry, 'scale', [[0.06, 1.35, 1.35], [0.18, 0.88, 0.88], [0.4, 1.08, 1.08], [0.7, 0.98, 0.98]], duration);
          put(cherry, 'rotate', [[0.1, -12], [0.3, 10], [0.6, -4]], duration);
          put(cherry, 'translate', [[0.08, 0, 18 * scale], [0.22, 0, -8 * scale], [0.5, 0, 4 * scale]], duration);
        }
        if (glow) put(glow, 'scale', [[0.05, 0.4, 0.4], [0.15, 2.0, 2.0], [0.4, 1.2, 1.2], [0.8, 0.7, 0.7]], duration);
        if (star) {
          put(star, 'scale', [[0.08, 1.8, 1.8], [0.25, 1.0, 1.0], [0.5, 1.4, 1.4], [0.8, 0.6, 0.6], [0.95, 0.3, 0.3]], duration);
          put(star, 'rotate', [[0.95, 200]], duration);
          put(star, 'translate', [[0.3, 50 * scale, 70 * scale], [0.95, 55 * scale, 75 * scale]], duration);
        }
        if (star2) {
          put(star2, 'scale', [[0.1, 1.5, 1.5], [0.3, 0.7, 0.7], [0.6, 1.1, 1.1], [0.95, 0.2, 0.2]], duration);
          put(star2, 'rotate', [[0.95, -160]], duration);
          put(star2, 'translate', [[0.35, -60 * scale, -45 * scale], [0.95, -65 * scale, -50 * scale]], duration);
        }
        const dirs = [[96, 4], [120, 80], [50, 83], [14, 108], [-66, 169], [-181, 91], [-181, -14], [-140, -106], [-100, -219], [-23, -156], [80, -120], [140, 20]];
        particles.forEach((bone, index) => {
          const [tx, ty] = dirs[index % dirs.length];
          const lag = (index % 8) * 0.015;
          put(bone, 'translate', [[0.05 + lag, 0, 0], [0.2 + lag, tx * 0.35 * scale, ty * 0.35 * scale], [0.55, tx * 0.9 * scale, ty * 0.9 * scale], [0.95, tx * scale, ty * scale]], duration);
          put(bone, 'scale', [[0.05 + lag, 0, 0], [0.15 + lag, 1.5, 1.5], [0.4, 1.0, 1.0], [0.7, 0.5, 0.5], [0.95, 0, 0]], duration);
          put(bone, 'rotate', [[0.95, (index % 2 ? 1 : -1) * (80 + index * 22)]], duration);
        });
      }
    }
    if (!Object.keys(animation.bones).length && named.has('root')) {
      put('root', 'translate', [[clip.duration * 0.5, 0, 8]], clip.duration);
    }
    return animation;
  }

  return { PINNED, PHRASES, applyPhrases, build };
});
