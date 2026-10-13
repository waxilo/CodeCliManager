// 项目 tsconfig 只含 ES2020 + DOM，未引入 @types/node。
// 这里按「只在测试里用到的最小面」补充声明，避免为读一个样式表就新增依赖。

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string;
}

declare const process: { cwd(): string };
