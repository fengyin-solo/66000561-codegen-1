# 分布式任务工作流DAG编排与执行引擎

基于Vue 3 + FastAPI的任务编排平台，DAG拓扑排序、任务状态机、多Worker并发池、执行甘特图。

## 目标用户
数据工程师、ETL/ML Pipeline开发者、技术架构师

## 技术栈
- 前端: Vue 3 + TypeScript + Vite + Pinia + Element Plus + ECharts
- 后端: Python FastAPI + NumPy + SQLite + WebSocket

## 核心功能
1. DAG工作流编辑器：拖拽添加任务节点、连线建立依赖关系、BFS拓扑排序验证环检测
2. Spring StateMachine风格任务状态机：PENDING→RUNNING→SUCCESS/FAILED/TIMEOUT
3. 多Worker并发池模拟：可配置Worker数量、任务执行耗时模拟(指数分布)
4. 任务编排策略：FIFO/优先级/最大并发三种调度策略
5. 重试机制：可配置最大重试次数、指数退避延迟
6. 执行监控：ECharts甘特图时间线渲染、实时WebSocket推送任务状态
7. 熔断保护：连续失败阈值触发熔断，冷却时间后自动恢复
