import test from 'node:test';
import assert from 'node:assert/strict';
import Schemastery from '@deepseek-ai/schemastery';
import {Config} from '../src/config-schema.js';
import {CONFIG_DEFAULTS} from '../src/config-fields.js';
import {normalizeLifeConfig} from '../src/config.js';
import {validateAll} from '../src/client/logic.js';
import {CONFIG_FIELDS} from '../src/config-fields.js';

test('Desktop schema rehydration accepts persisted range-valid values between UI increments', () => {
 const values={...CONFIG_DEFAULTS,wakeIntervalSeconds:61,tokenLimit:101,tickIntervalMs:1101};
 assert.deepEqual(validateAll(values,CONFIG_FIELDS),{});
 assert.doesNotThrow(()=>normalizeLifeConfig(values));
 assert.equal(Config['~standard'].validate(values).issues,undefined);
 assert.doesNotThrow(()=>new Schemastery(Config.toJSON())(values));
 assert.throws(()=>new Schemastery(Config.toJSON())({...values,wakeIntervalSeconds:601}));
 assert.ok(Config['~standard'].validate({...values,wakeIntervalSeconds:NaN}).issues);
 assert.throws(()=>normalizeLifeConfig({...values,wakeIntervalSeconds:NaN}));
});
