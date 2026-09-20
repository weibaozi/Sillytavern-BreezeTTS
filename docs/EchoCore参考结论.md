# EchoCore 的对白标注方案与 Breeze 适配

检查日期：2026-09-19；阅读 GitHub main 分支 README 与前端源码，未安装或运行 EchoCore，未改酒馆现有配置。

## 关键发现

EchoCore 的主要对白协议是 `[角色名, emotion] “对白”`。角色、情绪在短标记里，台词只在正文写一次。插件寻找标记后紧邻的引号内容，把标记在显示层替换成语音气泡；原对白保留。

这与此前试过的“把包含全文台词的 TTSVoice 移到正文前”不同。后者仍要求重复台词，而短标记模式不需要模型再抄写一次，也不需要插件把两份对白对齐。能否改善当前 glm-5.3 + TGbreak 的漏标，需要实际对照测试，源码本身不能证明。

来源：
- [默认提示词与动态注入](https://github.com/haide-D/SillyTavern-EchoCore/blob/main/frontend/js/prompt_injector.js)
- [标记解析与气泡生成](https://github.com/haide-D/SillyTavern-EchoCore/blob/main/frontend/js/dom_parser.js)

## 提示词由插件动态生成

插件从当前聊天和主角色收集人物，再结合已有音色映射，编译已绑定角色、主动跳过角色、新人物三类信息。已绑定角色的可用情绪来自参考音频或供应商预设；新人物用 New 提示用户绑定。最终通过 SillyTavern 的 setExtensionPrompt 注入，而不是让用户逐个手写音色列表。

这不等于完全不依赖模型标注。没有短标记的普通对白，气泡解析流程不会凭上下文自动识别并补全说话人。

来源：[prompt_injector.js](https://github.com/haide-D/SillyTavern-EchoCore/blob/main/frontend/js/prompt_injector.js)、[speaker_manager.js](https://github.com/haide-D/SillyTavern-EchoCore/blob/main/frontend/js/speaker_manager.js)。

## 值得借鉴与需要调整之处

| 设计 | Breeze 方案 |
| --- | --- |
| 元数据短标记，台词只写一次 | 值得优先对照测试；保留旧 TTSVoice 解析用于历史消息 |
| 标记替换为气泡，正文对白不重写 | 借鉴；原始聊天记录保留原标记 |
| 动态注入当前人物和可用情绪 | 借鉴；Breeze 的情绪与语气词规则单独定义 |
| 新人物提供快速绑定入口 | 借鉴；未映射不发起合成，不能自动套默认声音 |
| 音色映射复用 | 我们仍要求聊天独立映射；不能直接照搬其全局 mappings 行为 |
| 生成与顺序播放分离、切换聊天撤销旧朗读 | 借鉴；Breeze GPU 推理仍串行 |
| 全文朗读用旁白音色补未绑定人物 | 当前不采用；用户要求只读已绑定对白、无映射跳过 |

来源：[调度器](https://github.com/haide-D/SillyTavern-EchoCore/blob/main/frontend/js/scheduler.js)、[全文解析](https://github.com/haide-D/SillyTavern-EchoCore/blob/main/frontend/js/reading_text.js)、[README](https://github.com/haide-D/SillyTavern-EchoCore#全文朗读与连续读)。

## 解析边界

1. 短标记读取的是紧邻的第一段引号内容。`“够。”她点头。“走吧。”` 若只给第一段引号加标记，后一句不会自动继承；草案要求每一段独立引号对白都有标记。
2. 旧版 TTSVoice 兼容正则的文本部分是非贪婪匹配，到第一个右方括号结束；对于 `[TTSVoice:周启明:开心:走吧。[笑]]` 会提前闭合。我们的旧协议解析仍需括号嵌套计数。
3. GPT-SoVITS 供应商规则要求不插入行内音效标记；ElevenLabs 规则使用英文音效词。Breeze 的 `[笑]` 等不能直接套用这两类规则。
4. 不要把当前 TGbreak 的 w2g、catsay、摘要整体交给全文朗读；对白模式需明确过滤这些模块。

来源：[dom_parser.js](https://github.com/haide-D/SillyTavern-EchoCore/blob/main/frontend/js/dom_parser.js)、[供应商规则](https://github.com/haide-D/SillyTavern-EchoCore/blob/main/frontend/js/prompt_presets.js)。

## 接入方式

EchoCore 有 Provider 注册接口，可探索增加 BreezeProvider，但并非只换 API 地址：音色库、聊天独立映射、音色候选设计、中文语气词、缓存和本地串行调度都需要适配。其调度器目前通过供应商名称 GPT-SoVITS 判断本地任务，新增 Breeze 时尤其不能误走云端并发分支。

来源：[provider_manager.js](https://github.com/haide-D/SillyTavern-EchoCore/blob/main/frontend/js/providers/provider_manager.js)、[base_provider.js](https://github.com/haide-D/SillyTavern-EchoCore/blob/main/frontend/js/providers/base_provider.js)、[scheduler.js](https://github.com/haide-D/SillyTavern-EchoCore/blob/main/frontend/js/scheduler.js)。

## 下一步候选实验

旁边的《酒馆_短标记输出规范_EchoCore参考草案.txt》是适配 Breeze 的新草案，不是 EchoCore 原提示词，也尚未应用、测试。建议后续同一聊天同一问题比较：每段引号对白覆盖率、最后两句、台词是否完整、角色是否正确，以及现有其他模块是否保留。

采用短标记时，总格式中的旧 TTSVoice 指令必须同步换成对应短标记要求，不同时启用两套协议。初次可用手工预设测试，确认后再做插件动态注入。
