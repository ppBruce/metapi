import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ToastProvider } from '../../components/Toast.js';

import UpdateCenterSection from './UpdateCenterSection.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getUpdateCenterStatus: vi.fn(),
    checkUpdateCenter: vi.fn(),
    getUpdateCenterOta: vi.fn(),
    applyUpdateCenterOta: vi.fn(),
    rollbackUpdateCenterOta: vi.fn(),
  },
}));

vi.mock('../../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderSection() {
  let renderer: ReturnType<typeof create> | null = null;
  act(() => {
    renderer = create(
      <ToastProvider>
        <UpdateCenterSection />
      </ToastProvider>,
    );
  });
  return renderer!;
}

describe('UpdateCenterSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getUpdateCenterStatus.mockResolvedValue({
      currentVersion: '1.2.3',
      githubRelease: {
        normalizedVersion: '1.6.0',
        displayVersion: '1.6.0',
        tagName: 'v1.6.0',
        digest: null,
        publishedAt: null,
      },
      dockerHubTag: {
        normalizedVersion: '1.6.0',
        displayVersion: '1.6.0 @ sha256:aaaaaaaaaaaa',
        tagName: '1.6.0',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        publishedAt: null,
      },
      dockerHubRecentTags: [],
      runtime: {
        lastCheckedAt: '2026-08-10T02:00:00Z',
        lastCheckError: null,
      },
    });
    apiMock.checkUpdateCenter.mockResolvedValue({});
    apiMock.getUpdateCenterOta.mockResolvedValue({
      supported: false,
      state: { phase: 'idle', message: '' },
      applied: null,
      rollbackAvailable: false,
    });
  });

  it('renders current version and both version channels', async () => {
    const renderer = renderSection();
    await flushMicrotasks();

    const text = collectText(renderer.root);
    expect(text).toContain('1.2.3');
    expect(text).toContain('1.6.0');
    expect(text).toContain('GitHub Releases');
    expect(text).toContain('Docker Hub');
  });

  it('shows a new-version reminder badge when a newer release exists', async () => {
    const renderer = renderSection();
    await flushMicrotasks();

    const text = collectText(renderer.root);
    expect(text).toContain('发现新版本');
  });

  it('triggers a manual check via the check button', async () => {
    const renderer = renderSection();
    await flushMicrotasks();

    const buttons = renderer.root.findAllByType('button');
    const checkButton = buttons.find((btn) => collectText(btn).includes('检查更新'));
    expect(checkButton).toBeTruthy();

    await act(async () => {
      checkButton!.props.onClick();
    });

    expect(apiMock.checkUpdateCenter).toHaveBeenCalledTimes(1);
  });

  it('offers an online update when a supported OTA deployment sees a newer release', async () => {
    apiMock.getUpdateCenterOta.mockResolvedValue({
      supported: true,
      state: { phase: 'idle', message: '' },
      applied: null,
      rollbackAvailable: false,
    });
    apiMock.applyUpdateCenterOta.mockResolvedValue({ success: true });

    const renderer = renderSection();
    await flushMicrotasks();

    const buttons = renderer.root.findAllByType('button');
    const updateButton = buttons.find((btn) => collectText(btn).includes('更新到 v1.6.0'));
    expect(updateButton).toBeTruthy();

    await act(async () => {
      updateButton!.props.onClick();
    });
    await flushMicrotasks();

    expect(apiMock.applyUpdateCenterOta).toHaveBeenCalledWith('1.6.0');
    act(() => {
      renderer.unmount();
    });
  });

  it('shows the terminal command when host elevation falls back to manual', async () => {
    apiMock.getUpdateCenterOta.mockResolvedValue({
      supported: true,
      mode: 'host',
      host: { tier: 'manual', writableAppRoot: false, graphicalSession: false, pkexecAvailable: false, supervised: false },
      state: { phase: 'manual-required', message: '请复制以下命令在终端执行', command: 'sudo sh /tmp/metapi-ota-x/staging/ota-apply.sh' },
      applied: null,
      rollbackAvailable: false,
    });

    const renderer = renderSection();
    await flushMicrotasks();

    expect(collectText(renderer.root)).toContain('sudo sh /tmp/metapi-ota-x/staging/ota-apply.sh');
    act(() => {
      renderer.unmount();
    });
  });

  it('renders the last check error when present', async () => {
    apiMock.getUpdateCenterStatus.mockResolvedValue({
      currentVersion: '1.2.3',
      githubRelease: null,
      dockerHubTag: null,
      dockerHubRecentTags: [],
      runtime: {
        lastCheckedAt: null,
        lastCheckError: 'GitHub API timeout',
      },
    });

    const renderer = renderSection();
    await flushMicrotasks();

    expect(collectText(renderer.root)).toContain('GitHub API timeout');
  });

  it('places the warning-tinted rollback button left of the check-update control, with a confirm gate', async () => {
    apiMock.getUpdateCenterOta.mockResolvedValue({
      supported: true,
      state: { phase: 'idle', message: '' },
      applied: { status: 'applied', version: '1.6.0', fromVersion: '1.2.3' },
      rollbackAvailable: true,
    });
    apiMock.rollbackUpdateCenterOta.mockResolvedValue({ success: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const renderer = renderSection();
    await flushMicrotasks();

    const buttons = renderer.root.findAllByType('button');
    const rollbackButton = buttons.find((btn) => collectText(btn).includes('回滚到更新前版本'));
    // 有更新可用时主按钮变成「更新到 vX.Y.Z」——右侧主控件按 className 属性兜底匹配
    const checkButton = buttons.find((btn) => String(btn.props.className || '').includes('btn-primary'));
    expect(rollbackButton).toBeTruthy();
    expect(checkButton).toBeTruthy();
    const checkText = collectText(checkButton!);
    expect(checkText.includes('检查更新') || checkText.includes('更新到 v')).toBe(true);

    // 同一行、回滚在主按钮左侧
    expect(rollbackButton!.parent!.instance).toBe(checkButton!.parent!.instance);
    const rowChildren = rollbackButton!.parent!.children as Array<ReactTestInstance | string>;
    const rollbackIndex = rowChildren.findIndex((child) => typeof child !== 'string' && child.type === 'button' && collectText(child).includes('回滚到更新前版本'));
    const checkIndex = rowChildren.findIndex((child) => typeof child !== 'string' && child.type === 'button' && String(child.props.className || '').includes('btn-primary'));
    expect(rollbackIndex).toBeGreaterThanOrEqual(0);
    expect(rollbackIndex).toBeLessThan(checkIndex);

    // 警示橙样式 + 文字含目标版本
    const style = rollbackButton!.props.style as { color?: string; border?: string };
    expect(style.color).toBe('var(--color-warning)');
    expect(String(style.border)).toContain('--color-warning');

    // 取消确认时不发起回滚
    await act(async () => {
      rollbackButton!.props.onClick();
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(apiMock.rollbackUpdateCenterOta).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
    confirmSpy.mockRestore();
  });
});