import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import AccountRebindModal from './AccountRebindModal.js';

const form = { accessToken: '', platformUserId: '', refreshToken: '', tokenExpiresAt: '' };

function props() {
  return {
    open: true,
    accountLabel: 'tester',
    siteName: 'Demo Site',
    form,
    verifyResult: null,
    verifying: false,
    saving: false,
    showUserId: true,
    showSub2Api: false,
    inputStyle: {},
    onClose: vi.fn(),
    onFormChange: vi.fn(),
    onClearVerification: vi.fn(),
    onVerify: vi.fn(),
    onSubmit: vi.fn(),
  };
}

describe('AccountRebindModal', () => {
  it('renders a session rebind form for new-api without Sub2API-only fields', async () => {
    let root!: WebTestRenderer;
    await act(async () => {
      root = create(<AccountRebindModal {...props()} />);
    });
    try {
      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('重新绑定 Session Token');
      expect(rendered).toContain('tester');
      expect(rendered).toContain('Demo Site');
      expect(rendered).toContain('用户 ID（可选）');
      expect(rendered).not.toContain('Sub2API refresh_token（可选）');
      const submit = root.root.find((node) => node.type === 'button' && node.children.includes('确认重新绑定'));
      expect(submit.props.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
