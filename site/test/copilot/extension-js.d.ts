// 插件的 parse.js 是浏览器里直接加载的普通脚本（没有类型），测试里只为了执行它（它把 QCParse 挂在 globalThis 上）
declare module '*/extension/parse.js';
