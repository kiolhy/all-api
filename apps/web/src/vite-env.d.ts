/**
 * 只声明本项目实际用到的资源导入，避免依赖 `vite/client` 全局类型
 * （根 tsconfig 的 `types: ["node"]` 不引入 vite 类型）。
 */
declare module '*.css';
declare module '*.svg' {
  const src: string;
  export default src;
}
