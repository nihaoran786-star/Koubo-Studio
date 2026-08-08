# KouboRuntime · HeyGem bridge

这是 `KouboRuntime` 的自有协议桥脚手架。它只实现口播智能体已经固定的
`compatible_render` 协议，不包含、下载或重新分发 HeyGem/Duix 源码、模型、
`.so`、wheel 或容器镜像。

运行时边界：

```text
口播智能体 POST /render (127.0.0.1:8383)
→ HeyGemEngine
→ 内部 HeyGem-compatible /easy/submit + /easy/query (127.0.0.1:8384)
→ 将结果原子复制到应用指定的 WSL DrvFs 候选路径
```

默认会检查 `/opt/koubo/heygem/vendor/vendor-manifest.json` 及其声明的本地文件。
清单或任一资产缺失、为空、为符号链接，或内部服务未就绪时，`/health` 返回
503。仓库本身故意不提供这些 vendor 资产。

外置包还必须提供固定可执行文件
`/opt/koubo/heygem/vendor/bin/heygem-supervisor`。controller 只会用固定的
`start`、`stop` 参数调用它，并且只有内部 `127.0.0.1:8384/health` 就绪后才
启动 8383 bridge。内部 wrapper 必须实现 `POST /easy/cancel`；取消或超时后
必须终止对应推理并重建干净 worker，不能让被取消任务继续占用 GPU 或污染下一任务。

测试：

```text
python -m unittest discover -s runtime/koubo-heygem/tests -v
```
