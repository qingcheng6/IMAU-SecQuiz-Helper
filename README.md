# IMAU SecQuiz Helper

面向内蒙古农业大学网络安全知识问答页面的 Tampermonkey 用户脚本。它会在浏览器中保存题库和判分结果，优先匹配本地答案，必要时查询 DeepSeek。

## 安装

1. 在 Tampermonkey 中分别新建脚本，粘贴并保存 [题库记录脚本](答题助手/quiz-helper.user.js) 和 [连续答题脚本](答题助手/deepseek-hints.user.js)。更新已有安装时，直接替换同名脚本的内容。
2. 刷新答题页面，在右下角的「API 设置」中保存 DeepSeek API Key，点击「测试连接」。
3. 点击「开始连续答题」。可随时暂停，或关闭自动勾选和自动提交。

左侧面板可导入和导出题库，并查看最近的问题题目及实际提交答案。脚本等待服务器判分，答对后继续，明确答错或超时返回开始页后可自动开启下一轮。更多细节见 [安装说明](答题助手/DeepSeek安装说明.md)。

API Key 存在用户脚本管理器内。查询 DeepSeek 时会发送当前题干、题型和选项。题库和网页存档留在本地。

## 测试

在仓库根目录用 Node.js 运行以下命令。测试使用合成题目和模拟浏览器，不需要登录或 API Key。

```sh
node --test 答题助手/test.cjs 答题助手/test-deepseek.cjs 答题助手/test-saved-multiple.cjs 答题助手/test-submit.cjs
```
