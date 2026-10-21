import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    estimatePasswordBits,
    passwordStrength,
    isPasswordAcceptable,
    MIN_PASSWORD_LENGTH,
    WEAK_BITS,
    STRONG_BITS,
} from '../../src/utils/passwordStrength.ts';

test('short passwords or empty strings have 0 or weak entropy', () => {
    assert.equal(estimatePasswordBits(''), 0);
    assert.equal(isPasswordAcceptable('').acceptable, false);
    assert.equal(isPasswordAcceptable('short').acceptable, false);
    assert.equal(isPasswordAcceptable('short').reason, 'too_short');
});

test('common passwords and trivial patterns are flagged as weak (< 40 bits)', () => {
    const weakList = [
        '12345678',
        'password',
        'Password123!',
        'p@ssw0rd1',
        'qwertyuiop',
        'asdfghjkl',
        '1qaz2wsx',
        'iloveyou',
        'woaini1314',
        '5201314520',
        '2000-01-01',
        '19981225',
        'aaaaaaaa',
        'abc12345',
    ];

    for (const pwd of weakList) {
        const bits = estimatePasswordBits(pwd);
        assert.ok(
            bits < WEAK_BITS,
            `Expected "${pwd}" to have < ${WEAK_BITS} bits, got ${bits}`,
        );
        assert.equal(
            passwordStrength(pwd),
            'weak',
            `Expected "${pwd}" to be weak`,
        );
        const check = isPasswordAcceptable(pwd);
        assert.equal(check.acceptable, false, `Expected "${pwd}" to not be acceptable`);
        assert.equal(check.reason, 'too_weak');
    }
});

test('fair and strong passwords pass the threshold', () => {
    // Fair: around 40-60 bits
    const fair = 'correct-horse';
    const fairBits = estimatePasswordBits(fair);
    assert.ok(fairBits >= WEAK_BITS, `Expected "${fair}" >= ${WEAK_BITS}, got ${fairBits}`);

    // Strong: >= 60 bits
    const strong = 'correct-horse-battery-staple-99!';
    const strongBits = estimatePasswordBits(strong);
    assert.ok(strongBits >= STRONG_BITS, `Expected "${strong}" >= ${STRONG_BITS}, got ${strongBits}`);
    assert.equal(passwordStrength(strong), 'strong');

    const check = isPasswordAcceptable(strong);
    assert.equal(check.acceptable, true);
});
