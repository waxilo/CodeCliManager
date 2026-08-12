/** 异步请求序号守卫：避免过期结果回写 */
export function createRequestGuard(): {
  next(): number;
  isCurrent(id: number): boolean;
} {
  let current = 0;
  return {
    next(): number {
      return ++current;
    },
    isCurrent(id: number): boolean {
      return id === current;
    },
  };
}
