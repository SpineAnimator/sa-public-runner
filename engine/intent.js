/* Deterministic RU/UK/EN motion compiler.
 * Known actions get a specific choreography. An unrecognized phrase still
 * becomes one generated clip instead of a shoot-only rejection.
 * Conflicting counts, durations and directions fail visibly; IK and layer-only
 * mode are explicit capabilities independent from action and subject.
 */
(function (root, factory) {
  'use strict';
  const library = (typeof module === 'object' && module.exports) ? require('./etalons.js') : root.SpineEtalons;
  const api = factory(library || null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpineIntent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (library) {
  'use strict';
  class IntentError extends Error {
    constructor(code, message) { super(message); this.name = 'IntentError'; this.code = code; }
  }
  const fail = (code, message) => { throw new IntentError(code, message); };
  const numbers = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,
    один:1,одна:1,одно:1,одну:1,два:2,две:2,дві:2,двоє:2,три:3,четыре:4,чотири:4,
    пять:5,"п'ять":5,пʼять:5,шесть:6,шість:6,семь:7,сім:7,восемь:8,вісім:8};
  const isCountNoun = word => /^(анимаци|анімаці|вариант|варіант|animation|clip|variant|выстрел|постріл|shot|прыж|стриб|шаг|бег|біг|танц|удар|мах|поклон|кив)/u.test(word || '');
  const isSecond = word => /^(секунд|seconds?$|secs?$|s$|с$)/u.test(word || '');
  const ACTION_RULES = [
    ['shoot', /^(выстрел\p{L}*|стрел\p{L}*|стрельб\p{L}*|постріл\p{L}*|стрільб\p{L}*|shoot\p{L}*|shots?|fire|firing)$/u],
    ['cards_in', /^(cardsin)$/u],
    ['half_turn', /^(halfturn)$/u],
    ['hand_twitch', /^(handtwitch)$/u],
    ['funny', /^(funnyetalon)$/u],
    ['cherry_idle', /^(cherryidle)$/u],
    ['appear', /^(appearfx)$/u],
    ['burst', /^(burstfx)$/u],
    ['idle', /^(idle|breath\p{L}*|дыхани\p{L}*|дыш\p{L}*|дихан\p{L}*|диха\p{L}*|сто[йия]\p{L}*|стойк\p{L}*|покой\p{L}*|спок[оі]\p{L}*|stand\p{L}*)$/u],
    ['walk', /^(walk\p{L}*|steps?|ходьб\p{L}*|шаг\p{L}*|шага\p{L}*|идти|идёт|идет|іти|ход[иі]ть|прогул\p{L}*)$/u],
    ['run', /^(runs?|running|sprint\p{L}*|бег\p{L}*|беж\p{L}*|біг\p{L}*|біж\p{L}*)$/u],
    ['jump', /^(jumps?|jumping|hops?|прыж\p{L}*|прыг\p{L}*|подпрыг\p{L}*|стриб\p{L}*)$/u],
    ['wave', /^(waves?|waving|мах(?!ин)\p{L}*|маш(?!ин)\p{L}*|помаха\p{L}*|помаш(?!ин)\p{L}*|привет\p{L}*|привіт\p{L}*|hello|hi)$/u],
    ['attack', /^(attacks?|attacking|hits?|punch\p{L}*|kicks?|slash\p{L}*|strikes?|удар\p{L}*|ударить|бить|бь[её]\p{L}*|атак\p{L}*)$/u],
    ['hurt', /^(hurt\p{L}*|flinch\p{L}*|damage\p{L}*|ранен\p{L}*|урон\p{L}*|попадани\p{L}*)$/u],
    ['death', /^(die|dies|dying|death|dead|falls|falling|смерт\p{L}*|умер\p{L}*|умир\p{L}*|паден\p{L}*|падін\p{L}*)$/u],
    ['dance', /^(danc\p{L}*|танец\p{L}*|танц\p{L}*|танцу\p{L}*|танцю\p{L}*)$/u],
    ['bow', /^(bows?|bowing|поклон\p{L}*|вклон\p{L}*|уклін\p{L}*)$/u],
    ['reload', /^(reload\p{L}*|перезаряд\p{L}*|заряд\p{L}*)$/u],
    ['celebrate', /^(celebrat\p{L}*|victory|win|побед\p{L}*|перемог\p{L}*|радост\p{L}*|праздн\p{L}*)$/u],
    ['crouch', /^(crouch\p{L}*|squats?|присед\p{L}*|присід\p{L}*)$/u],
    ['look', /^(look\p{L}*|glance\p{L}*|взгляд\p{L}*|смотр\p{L}*|дивит\p{L}*|посмотр\p{L}*)$/u],
    ['turn', /^(turns?|turning|поворот\p{L}*|поворач\p{L}*|разворот\p{L}*|оберт\p{L}*)$/u],
    ['float', /^(floats?|floating|fly|flies|flying|hover\p{L}*|парит\p{L}*|паріт\p{L}*|летать|летает|летаю|летит|летят|лечу|літа\p{L}*|політ|полёт|полет)$/u],
    ['shake', /^(shakes?|shaking|trembl\p{L}*|дрож\p{L}*|тряс\p{L}*|тремт\p{L}*)$/u],
    ['nod', /^(nods?|nodding|кив\p{L}*|кивок|кивн\p{L}*)$/u]
  ];
  const DIRECTION_RULES = {
    up: /^(вверх$|вгору$|up$|upward|upwards$)/u,
    down: /^(вниз$|донизу$|down$|downward|downwards$)/u,
    left: /^(влево$|ліворуч$|налево$|left$)/u,
    right: /^(вправо$|праворуч$|направо$|right$)/u,
    forward: /^(вперед$|вперёд$|впереди$|forward|straight$)/u
  };
  const FILLER = /^(правильн\p{L}*|корректн\p{L}*|коректн\p{L}*|скелет\p{L}*|skeleton|rig|correct|proper|с|со|з|із|на|для|и|й|та|а|і|the|a|an|with|for|and|of|to|в|во|у|in|по|из|із|от|до|each|кажд\p{L}*|кожн\p{L}*|длительност\p{L}*|триваліст\p{L}*|duration|lasting|создай|создать|сделай|сделать|нужно|нужны|нужен|нужна|пожалуйста|створи|зроби|потрібно|please|create|make|generate|give|want|inverse|kinematics|обратн\p{L}*|кинематик\p{L}*|зворотн\p{L}*|кінематик\p{L}*|персонаж\p{L}*|герой\p{L}*|character|hero|движени\p{L}*|motion|move|moving|голов\p{L}*|head|body|тел\p{L}*|вариант\p{L}*|варіант\p{L}*|обе|обеих|обоих|обеими|обидві|обидвох|обох|both)$/u;
  const MODIFIER = /^(быстр\p{L}*|медлен\p{L}*|сильн\p{L}*|слаб\p{L}*|плавн\p{L}*|резк\p{L}*|легк\p{L}*|тяжел\p{L}*|широк\p{L}*|коротк\p{L}*|высок\p{L}*|низк\p{L}*|больш\p{L}*|маленьк\p{L}*|мягк\p{L}*|жестк\p{L}*|аккурат\p{L}*|мощн\p{L}*|тих\p{L}*|громк\p{L}*|fast|slow|strong|weak|smooth|sharp|big|small|gentle|hard|high|low|quick|long|short|once|loop\p{L}*|цикл\p{L}*|повтор\p{L}*)$/u;
  const DENY = /^(process|exit|eval|function|script|require|import|constructor|prototype|camera|камер\p{L}*)$/u;
  const matchAction = word => {
    for (const [action, rule] of ACTION_RULES) if (rule.test(word)) return action;
    return null;
  };
  const matchDirection = word => Object.keys(DIRECTION_RULES).find(key => DIRECTION_RULES[key].test(word)) || null;
  const slugAction = word => {
    const raw = String(word || '').toLocaleLowerCase().normalize('NFKC');
    let slug = raw.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
    if (!slug) return null;
    if (slug.length > 48) slug = slug.slice(0, 48);
    if (/^(ik|ик)$/u.test(slug)) return null;
    return slug;
  };
  const known = word => numbers[word] !== undefined || !!matchAction(word) || !!matchDirection(word) || isCountNoun(word) || isSecond(word) ||
    /^(рук\p{L}*|руц\p{L}*|hands?|arms?|ik|ик)$/u.test(word) || FILLER.test(word) || MODIFIER.test(word);
  const hashText = text => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  };

  function compileIntent(sourceText) {
    if (typeof sourceText !== 'string' || !sourceText.trim()) fail('EMPTY_REQUEST', 'Describe the animation.');
    if (sourceText.length > 4000) fail('REQUEST_TOO_LONG', 'The description is limited to 4000 characters.');
    const normalizedRaw = sourceText.toLocaleLowerCase().replace(/[’ʼ]/g, "'").replace(/(\d),(\d)/g, '$1.$2');
    const normalized = library && library.applyPhrases ? library.applyPhrases(normalizedRaw) : normalizedRaw;
    const tokens = normalized.match(/[\p{L}]+(?:'[\p{L}]+)*|\d+(?:\.\d+)?/gu) || [];
    for (const token of tokens) if (DENY.test(token)) fail('UNSUPPORTED_DETAIL', 'This cannot be a character animation: ' + token + '.');
    const used = new Set(), counts = [], actionCounts = [], durations = [];
    const genericCount = word => /^(анимаци|анімаці|вариант|варіант|animations?|clips?|variants?)/u.test(word || '');
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i], value = /^\d/.test(token) ? Number(token) : numbers[token];
      if (value === undefined) continue;
      if (isSecond(tokens[i + 1])) { durations.push(value); used.add(i); used.add(i + 1); continue; }
      const next = tokens.slice(i + 1, i + 4);
      const genericAt = next.findIndex(genericCount);
      const actionAt = next.findIndex(word => matchAction(word));
      if (genericAt !== -1 && (actionAt === -1 || genericAt < actionAt)) { counts.push(value); used.add(i); continue; }
      if (actionAt !== -1) { actionCounts.push({ action: matchAction(next[actionAt]), count: value }); used.add(i); continue; }
      if (next.some(w => /^(рук|руц|hand|arm)/u.test(w))) { used.add(i); continue; }
      fail('UNBOUND_NUMBER', 'Say whether the number is animations, variants, hands, or seconds.');
    }
    if (new Set(counts).size > 1) fail('CONFLICTING_COUNT', 'Animation count and variant count disagree.');
    const explicitCount = counts.length ? counts[0] : null;
    if (durations.length && new Set(durations).size > 1) fail('CONFLICTING_DURATION', 'One request needs one duration.');
    const duration = durations.length ? durations[0] : 2;
    if (!Number.isFinite(duration) || duration < 1 || duration > 30) fail('UNSUPPORTED_DURATION', 'Duration must be from 1 to 30 seconds.');
    const actions = [];
    for (const token of tokens) {
      const action = matchAction(token);
      if (action && !actions.includes(action)) actions.push(action);
    }
    const directions = [];
    const actionPositions = [];
    tokens.forEach((token, index) => {
      const action = matchAction(token);
      if (action) actionPositions.push({ action, index });
    });
    const boundDirection = new Map();
    for (let index = 0; index < tokens.length; index++) {
      const direction = matchDirection(tokens[index]);
      if (!direction) continue;
      if (!directions.includes(direction)) directions.push(direction);
      let target = null, best = Infinity;
      for (const item of actionPositions) {
        const distance = index - item.index;
        if (distance > 0 && distance <= 4 && distance < best) { best = distance; target = item; }
      }
      if (!target) {
        for (const item of actionPositions) {
          const distance = item.index - index;
          if (distance > 0 && distance <= 4 && distance < best) { best = distance; target = item; }
        }
      }
      if (!target) continue;
      const previous = boundDirection.get(target.action);
      if (previous && previous !== direction) fail('CONFLICTING_DIRECTION', 'Use one direction for one motion.');
      boundDirection.set(target.action, direction);
    }
    if (boundDirection.size === 0 && directions.length > 1) fail('CONFLICTING_DIRECTION', 'Use one direction.');
    const conflictingBound = boundDirection.size > 1 && new Set(boundDirection.values()).size > 1 && actions.length === 1;
    if (conflictingBound) fail('CONFLICTING_DIRECTION', 'Use one direction.');
    const ikMentioned = tokens.some(w => w === 'ik' || w === 'ик') || /inverse\s+kinematics|обратн\p{L}*\s+кинематик|зворотн\p{L}*\s+кінематик/u.test(normalized);
    const withoutIK = /(?:без|without|no)\s+(?:ik|ик|inverse\s+kinematics|обратн\p{L}*\s+кинематик\p{L}*)|не\s+(?:нуж\p{L}*|использ\p{L}*)\s+(?:ik|ик)/u.test(normalized);
    const withoutSkeleton = /(?:без\s+(?:скелет\p{L}*|кост\p{L}*)|(?:without|no)\s+(?:a\s+)?(?:skeleton|bones?))/u.test(normalized);
    const ik = ikMentioned && !withoutIK;
    if (withoutSkeleton && ik) fail('CONFLICTING_RIG', 'IK needs a bone chain: choose IK or the no-skeleton mode.');
    const hands = tokens.some(w => /^(рук|hand|arm)/u.test(w));
    if (ik && !hands) fail('IK_TARGET_REQUIRED', 'Set IK on both hands.');
    const bothHands = ik && (/(?:две|два|дві|two|2|обе|обидві|both)\s+(?:рук\p{L}*|arms?|hands?)/u.test(normalized));
    if (ik && !bothHands) fail('UNSUPPORTED_IK_TARGET', 'IK is supported for both hands. Name both hands.');
    const modeWords = /^(без|without|no|не|нуж\p{L}*|использ\p{L}*|скелет\p{L}*|кост\p{L}*|bones?|skeleton)$/u;
    // Unrecognized words describe the subject or a freeform phrase; they must not
    // silently create additional clips. The cloud planner interprets full text.
    // Browser-only fallback uses a single explicit generic action when no known verb exists.
    const freeform = [];
    tokens.forEach((word, index) => {
      if (used.has(index) || modeWords.test(word) || FILLER.test(word) || MODIFIER.test(word)) return;
      if (numbers[word] !== undefined || isSecond(word) || isCountNoun(word) || matchDirection(word)) return;
      if (/^(рук\p{L}*|руц\p{L}*|hands?|arms?|ik|ик)$/u.test(word)) return;
      if (matchAction(word)) return; // already in actions
      const slug = slugAction(word);
      if (slug && !freeform.includes(slug) && !actions.includes(slug)) freeform.push(slug);
    });
    const unknown = freeform.slice();
    if (!actions.length && unknown.length) actions.push('perform');
    if (!actions.length) fail('MISSING_ACTION', 'Describe the motion: jump, run, dance, attack, idle, shoot, or your own phrase.');
    let sequence;
    if (actionCounts.length) {
      const perAction = new Map();
      for (const item of actionCounts) {
        if (!Number.isInteger(item.count) || item.count < 1 || item.count > 8) fail('UNSUPPORTED_COUNT', 'From 1 to 8 animations are supported.');
        if (perAction.has(item.action) && perAction.get(item.action) !== item.count) fail('CONFLICTING_COUNT', 'Animation count and variant count disagree.');
        perAction.set(item.action, item.count);
      }
      sequence = [];
      for (const action of actions) {
        const repeats = perAction.has(action) ? perAction.get(action) : 1;
        for (let i = 0; i < repeats; i++) sequence.push(action);
      }
      if (explicitCount !== null && explicitCount !== sequence.length) fail('CONFLICTING_COUNT', 'Animation count and variant count disagree.');
    } else {
      const clipCount = explicitCount === null ? (actions.length > 1 ? actions.length : 1) : explicitCount;
      if (!Number.isInteger(clipCount) || clipCount < 1 || clipCount > 8) fail('UNSUPPORTED_COUNT', 'From 1 to 8 animations are supported.');
      sequence = Array.from({ length: clipCount }, (_, i) => actions.length === 1 ? actions[0] : actions[i % actions.length]);
    }
    if (sequence.length < 1 || sequence.length > 8) fail('UNSUPPORTED_COUNT', 'From 1 to 8 animations are supported.');
    const directionFor = action => {
      if (boundDirection.has(action)) return boundDirection.get(action);
      if (boundDirection.size === 0 && directions.length === 1) return directions[0];
      if (boundDirection.size === 0 && actions.length === 1 && action === 'shoot') return 'forward';
      return null;
    };
    const seen = Object.create(null);
    const seedBase = hashText(normalizedRaw);
    const clips = sequence.map((action, i) => {
      const variant = (seen[action] = (seen[action] || 0) + 1);
      const direction = directionFor(action);
      const name = action + (direction ? '_' + direction : '') + '_' + String(i + 1).padStart(2, '0');
      const clip = {
        name, action, direction, variant, duration,
        intensity: Number((1 + (variant - 1) * 0.16).toFixed(2)),
        seed: (seedBase + i * 9973) >>> 0
      };
      if (action === 'shoot') {
        clip.recoilScale = Number((1 + (variant - 1) * .15).toFixed(2));
        clip.shotCount = Math.min(variant, 4);
      }
      if (action === 'perform' && unknown.length) clip.phrase = unknown.slice(0, 4).join(' ');
      return clip;
    });
    const direction = clips.every(clip => clip.direction === clips[0].direction) ? clips[0].direction : null;
    const clipCount = clips.length;
    const onlyShoot = actions.length === 1 && actions[0] === 'shoot';
    // A motion name never invents limbs or constraints. IK is an explicit
    // optional capability, independent from the choreography and the subject.
    const armIK = { enabled: ik, bothHands, arms: bothHands ? ['left', 'right'] : [], required: ik };
    return {
      schemaVersion: 2,
      compiler: 'motion-v2',
      sourceText,
      action: actions.length === 1 ? actions[0] : 'mixed',
      direction,
      clipCount,
      duration,
      subject: unknown,
      clips,
      rig: {
        mode: withoutSkeleton ? 'layers' : 'rig',
        skeletonRequested: !withoutSkeleton,
        technicalBonesOnly: withoutSkeleton,
        armIK,
        preserveInitialPose: true,
        preserveDrawOrder: true
      },
      requirements: { preserveInitialPose: true, preserveDrawOrder: true, preserveSourceArtwork: true },
      assumptions: [
        ...(explicitCount === null && actionCounts.length === 0 && actions.length < 2 ? ['Count omitted: one animation.'] : []),
        ...(durations.length ? [] : ['Duration omitted: 2 seconds.']),
        ...(withoutSkeleton ? ['No skeleton: each layer is independent. Spine uses only technical bones for the root and the layers, with no anatomy and no IK.'] : []),
        ...(onlyShoot && !directions.length ? ['Direction omitted: forward.'] : []),
        ...(freeform.length ? ['Unrecognized words are not additional animations: ' + freeform.join(', ') + '.'] : []),
        ...(actions.length === 1 && actions[0] === 'perform' ? ['No recognized motion verb; browser-only fallback creates a generic movement. Use @2Spine cloud planning for an artwork-aware result.'] : [])
      ],
      limitations: ['Different motions may face different directions. One duration per request, from 1 to 30 seconds. Words that are not a motion do not choose the artwork: the PSD layers do. A phrase with no known motion gets one generic sway. The shoot, cards, half-turn, hand, and funny references stay in the build.']
    };
  }
  return { compileIntent, IntentError };
});
