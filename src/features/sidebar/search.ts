import { appState } from '../../state';
import { refreshConversationListDom } from './render-list';
export function bindSidebarSearch() {
  const input = document.querySelector<HTMLInputElement>('#sidebar-search-input');
  const clearBtn = document.querySelector<HTMLButtonElement>('#sidebar-search-clear');
  if (!input) return;

  const apply = (value: string) => {
    appState.sidebarSearchQuery = value;
    if (clearBtn) clearBtn.hidden = value.trim().length === 0;
    refreshConversationListDom();
  };

  input.addEventListener('input', () => apply(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      input.value = '';
      apply('');
    }
  });

  clearBtn?.addEventListener('click', () => {
    input.value = '';
    apply('');
    input.focus();
  });
}

/** 工作区卡片标题支持键盘展开/收起 */
