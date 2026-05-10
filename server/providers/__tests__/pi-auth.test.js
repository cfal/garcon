import { describe, expect, it } from 'bun:test';

import { hasPiModelRows } from '../pi-auth.js';

describe('Pi auth status helpers', () => {
  it('treats table rows as authenticated model availability', () => {
    expect(hasPiModelRows(`
provider   model            context   max-out   thinking   images
openai     gpt-5.4          400K      128K      yes        yes
`)).toBe(true);
  });

  it('does not treat guidance text as model availability', () => {
    expect(hasPiModelRows('No models are configured. Run pi to configure a provider.')).toBe(false);
  });
});
