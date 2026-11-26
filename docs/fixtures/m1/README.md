# M1 验收样本

- `disconnect.log` 含两次断连。连接 `alpha` 在第 2 行断连，第 4 行恢复。连接 `beta` 在第 6 行断连，恢复行为未知，`reconnectLine` 为 `null`。
- `healthy.log` 包含完整的无断连样本，正确结果为 `no_disconnect`，事故列表为空。
- 空文件或格式不完整的文件对应 `unknown`。把 `disconnect.log` 的恢复行写成第 3 行，或将原始摘要换成其他文件摘要，均应拒收。
