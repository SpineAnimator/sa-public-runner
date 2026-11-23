'use strict';
(function(){
const PROFILES = Object.freeze({
  'animation-task': Object.freeze({
    runFullTestSuite: false,
    runUnitTestsInline: false,
    validationMode: 'critical-only',
    requiredChecks: Object.freeze([
      'plan-schema',
      'dependency-order',
      'tool-capabilities',
      'blocked-plan-preflight',
      'operation-failure-state'
    ]),
    fullTests: 'dedicated-code-ci-only'
  }),
  'development-ci': Object.freeze({
    runFullTestSuite: true,
    runUnitTestsInline: false,
    validationMode: 'full',
    requiredChecks: Object.freeze(['full-test-suite', 'integration-tests', 'build'])
  })
});

function resolveExecutionPolicy(profile = 'animation-task') {
  const policy = PROFILES[profile];
  if (!policy) throw new Error('SA execution policy: unknown profile ' + profile);
  return {
    profile,
    runFullTestSuite: policy.runFullTestSuite,
    runUnitTestsInline: policy.runUnitTestsInline,
    validationMode: policy.validationMode,
    requiredChecks: [...policy.requiredChecks],
    fullTests: policy.fullTests || null
  };
}

function isTestCapability(capability) {
  return typeof capability === 'string' && /^(?:test|tests|ci\.test|ci\.tests|test-suite|npm\.test)(?:[./:-]|$)/i.test(capability);
}

function shouldRunFullTests({ profile = 'animation-task', trigger = 'animation-task' } = {}) {
  if (trigger === 'animation-task' || trigger === 'interactive-animation') return false;
  return resolveExecutionPolicy(profile).runFullTestSuite;
}

const api = { PROFILES, resolveExecutionPolicy, shouldRunFullTests, isTestCapability };
if (typeof module === 'object' && module.exports) module.exports = api;
else if (typeof globalThis !== 'undefined') globalThis.SAExecutionPolicy = api;
})();
