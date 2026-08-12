import { escapeHtml } from '../../utils';
import type { ApiProfileItem } from '../../types';

/** 官方默认伪配置标识 */
export const OFFICIAL_PROFILE_ID = '__official__';
export function closeProfileContextMenu() {
  document.querySelector('.profile-context-menu-overlay')?.remove();
}

export interface ProfileContextMenuOptions {
  x: number;
  y: number;
  profileId: string;
  profileName: string;
  isActive: boolean;
  allowDelete?: boolean;
  onApply: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}

export function showProfileContextMenu(options: ProfileContextMenuOptions) {
  closeProfileContextMenu();

  const overlay = document.createElement('div');
  overlay.className = 'profile-context-menu-overlay';
  overlay.innerHTML = `
    <div
      class="profile-context-menu"
      role="menu"
      style="left: ${options.x}px; top: ${options.y}px"
    >
      <button
        type="button"
        class="profile-context-menu-item"
        data-action="apply"
        ${options.isActive ? 'disabled' : ''}
        ${options.isActive ? 'title="该配置正在使用中"' : ''}
      >应用</button>
      ${options.allowDelete === false ? '' : `<button
        type="button"
        class="profile-context-menu-item profile-context-menu-item-danger"
        data-action="delete"
        ${options.isActive ? 'disabled' : ''}
        ${options.isActive ? 'title="无法删除正在使用的配置"' : ''}
      >删除</button>`}
    </div>
  `;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close();
    }
  };

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  overlay.querySelector('[data-action="apply"]')?.addEventListener('click', async () => {
    if (options.isActive) return;
    close();
    await options.onApply();
  });

  overlay.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    if (options.isActive) return;
    close();
    await options.onDelete();
  });

  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(overlay);

  const menu = overlay.querySelector('.profile-context-menu') as HTMLElement | null;
  if (menu) {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
    }
  }
}

export function renderSettingsProfileList(profiles: ApiProfileItem[], selectedProfileId: string | null): string {
  const officialActive = !profiles.some((p) => p.isActive);
  const officialSelected = selectedProfileId === OFFICIAL_PROFILE_ID;
  const officialItem = `
    <div
      class="settings-profile-item settings-profile-official ${officialActive ? 'active' : ''} ${officialSelected ? 'selected' : ''}"
      data-official="true"
      role="button"
      tabindex="0"
      aria-label="使用官方默认（Claude 订阅）"
    >
      ${officialActive ? '<span class="settings-profile-badge">使用中</span>' : ''}
      <div class="settings-profile-main">
        <span class="settings-profile-name">官方默认</span>
        <span class="settings-profile-meta">Claude 订阅 / 官方登录（清除自定义 API）</span>
      </div>
    </div>
  `;

  if (profiles.length === 0) {
    return officialItem;
  }

  return officialItem + profiles
    .map((profile) => {
      const isSelected = selectedProfileId === profile.id;
      const isActive = profile.isActive;
      return `
        <div
          class="settings-profile-item ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''}"
          data-profile-id="${profile.id}"
          role="button"
          tabindex="0"
          aria-label="选择配置 ${escapeHtml(profile.name)}"
        >
          ${isActive ? '<span class="settings-profile-badge">使用中</span>' : ''}
          <div class="settings-profile-main">
            <span class="settings-profile-name">${escapeHtml(profile.name)}</span>
            <span class="settings-profile-meta">${escapeHtml(profile.baseUrl || '未设置 Base URL')}</span>
          </div>
        </div>
      `;
    })
    .join('');
}


/** 切换右侧表单是否可编辑（官方默认只读、无需保存） */
