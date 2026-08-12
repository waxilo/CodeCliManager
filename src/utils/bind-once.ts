/**
 * 基于 dataset 标记的一次性绑定：已绑过则跳过，否则标记并执行 fn。
 * @param key dataset 属性名（如 'bound'）
 */
export function bindOnce(el: HTMLElement, key: string, fn: () => void): void {
  if (el.dataset[key]) return;
  el.dataset[key] = '1';
  fn();
}
