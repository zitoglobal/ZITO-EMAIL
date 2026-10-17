/** 供 customer_timeline 使用的轻量导出，避免循环依赖拉起 focus 全量 */
export { domainOf, isFreeDomain, suggestFollowAction } from './priority.js';
