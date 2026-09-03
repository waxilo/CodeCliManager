import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from '../../state';
import {
  handlePaste,
  LARGE_PASTE_THRESHOLD_BYTES,
  MAX_PASTED_TEXT_BYTES,
} from './index';

const writeClipboardText = vi.fn();
const writeClipboardImage = vi.fn();

vi.mock('../../api', () => ({
  writeClipboardText: (...args: unknown[]) => writeClipboardText(...args),
  writeClipboardImage: (...args: unknown[]) => writeClipboardImage(...args),
}));

function pasteEvent(text: string, input: HTMLTextAreaElement): ClipboardEvent {
  return {
    clipboardData: {
      items: [{ type: 'text/plain' }],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
    currentTarget: input,
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('large pasted text attachments', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <textarea id="message-input"></textarea>
      <div id="imported-file-bar"></div>
      <button id="send-btn"></button>
    `;
    appState.activeConversationId = '';
    appState.activePendingSessionKey = '';
    appState.pendingProjectDir = '/project-a';
    appState.importedFileRefs = [];
    appState.pasteAttachments = [];
    appState.composerDrafts.clear();
    appState.runningSessions.clear();
    writeClipboardText.mockReset();
    writeClipboardImage.mockReset();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
  });

  it('leaves small text to the browser default paste behavior', async () => {
    const input = document.querySelector<HTMLTextAreaElement>('#message-input')!;
    const event = pasteEvent('small paste', input);

    await handlePaste(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it('uses UTF-8 bytes and turns large text into a file card', async () => {
    const input = document.querySelector<HTMLTextAreaElement>('#message-input')!;
    const text = '中'.repeat(Math.floor(LARGE_PASTE_THRESHOLD_BYTES / 3) + 1);
    const event = pasteEvent(text, input);
    writeClipboardText.mockResolvedValue(
      '/project-a/.clipboard-uploads/pasted-text-test.txt',
    );

    await handlePaste(event);
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(writeClipboardText).toHaveBeenCalledWith(
      '/project-a',
      expect.stringMatching(/^pasted-text-\d+-[\w-]+\.txt$/),
      text,
    );
    expect(appState.importedFileRefs).toEqual([
      {
        ref: '@File[/project-a/.clipboard-uploads/pasted-text-test.txt]',
        fileName: expect.stringMatching(/^pasted-text-/),
        isImage: false,
        isDir: false,
      },
    ]);
    expect(document.querySelector('#imported-file-bar')?.textContent).toContain('pasted-text-');
    expect(input.value).toBe('');
  });

  it('keeps an asynchronously written attachment with its source draft after switching', async () => {
    const input = document.querySelector<HTMLTextAreaElement>('#message-input')!;
    const text = 'x'.repeat(LARGE_PASTE_THRESHOLD_BYTES + 1);
    const event = pasteEvent(text, input);
    const write = deferred<string>();
    writeClipboardText.mockReturnValue(write.promise);

    await handlePaste(event);
    appState.pendingProjectDir = '/project-b';
    write.resolve('/project-a/.clipboard-uploads/pasted-text-test.txt');
    await flushPromises();

    expect(appState.importedFileRefs).toEqual([]);
    expect(appState.composerDrafts.get('new:/project-a')?.importedFileRefs).toEqual([
      {
        ref: '@File[/project-a/.clipboard-uploads/pasted-text-test.txt]',
        fileName: expect.stringMatching(/^pasted-text-/),
        isImage: false,
        isDir: false,
      },
    ]);
  });

  it('restores large text at the original selection when writing fails', async () => {
    const input = document.querySelector<HTMLTextAreaElement>('#message-input')!;
    input.value = 'before AFTER';
    input.setSelectionRange(7, 12);
    const text = 'x'.repeat(LARGE_PASTE_THRESHOLD_BYTES + 1);
    const event = pasteEvent(text, input);
    writeClipboardText.mockRejectedValue(new Error('disk full'));

    await handlePaste(event);
    await flushPromises();

    expect(input.value).toBe(`before ${text}`);
    expect(input.selectionStart).toBe(7 + text.length);
  });

  it('rejects text over 25 MiB without invoking the backend writer', async () => {
    const input = document.querySelector<HTMLTextAreaElement>('#message-input')!;
    const event = pasteEvent('x'.repeat(MAX_PASTED_TEXT_BYTES + 1), input);

    await handlePaste(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(writeClipboardText).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });
});
