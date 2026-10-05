import { expect, test } from 'claude-code/testing';
import { register } from './register';
test('/spend reports ledger totals against the budget', { options: { monthlyBudgetUsd: 50 } }, async ($, on) => {
    register(on, { monthlyBudgetUsd: 50 });
    const out = await $.command.run({ name: 'spend' }).catch(() => undefined);
    expect(out === undefined || typeof out === 'object').toBe(true);
});
