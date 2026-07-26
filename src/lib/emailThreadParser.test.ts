import { describe, it, expect } from 'vitest';
import { parseEmailThread } from './emailThreadParser';

describe('emailThreadParser', () => {
  it('应当能正确识别无转发的普通邮件', () => {
    const text = '你好，这是一封普通的邮件正文，没有历史转发。\n祝好！\n张三';
    const result = parseEmailThread(text);
    expect(result.hasHistory).toBe(false);
    expect(result.latestMessage).toBe(text);
    expect(result.historicalThreads.length).toBe(0);
  });

  it('应当能区分个人签名分隔线与转发会话分隔线，精准切出最新正文与历史记录', () => {
    const text = `各位：      监控终端组周报，已形成，各位请查收
若有问题，可随时联系！
——————————————————————————————
钱惠君    信息技术研究院    监控终端组
手机：18600508641   邮箱：qianhj@chinatowercom.cn
地址：北京市海淀区东冉北街9号中国铁塔产业园7号楼2层   邮编：100195
------------------------------------------------------------------
发件人：钱惠君 <qianhj@chinatowercom.cn>
发送时间：2026年7月19日(星期日) 08:08
收件人："李淑雅"<lisy782@chinatowercom.cn>; "王依喆"<wangyz3@chinatowercom.cn>
抄　送："监控终端组"<it-terminal@chinatowercom.cn>
主　题：运维业务室-监控终端组周报0719

各位：      监控终端组周报0719，已形成，请查收！
------------------------------------------------------------------
发件人：钱惠君 <qianhj@chinatowercom.cn>
发送时间：2026年7月12日(星期日) 11:06
收件人："李淑雅"<lisy782@chinatowercom.cn>
主　题：回复：运维业务室-监控终端组周报0712

这是第三篇很早以前的周报内容。`;

    const result = parseEmailThread(text);
    expect(result.hasHistory).toBe(true);
    expect(result.historicalThreads.length).toBe(2);
    expect(result.latestMessage).toContain('各位：      监控终端组周报，已形成，各位请查收');
    expect(result.latestMessage).toContain('手机：18600508641');
    expect(result.latestMessage).not.toContain('运维业务室-监控终端组周报0719');

    expect(result.historicalThreads[0].index).toBe(0);
    expect(result.historicalThreads[0].sender).toContain('钱惠君');
    expect(result.historicalThreads[0].sendTime).toContain('2026年7月19日');
    expect(result.historicalThreads[0].subject).toContain('运维业务室-监控终端组周报0719');

    expect(result.historicalThreads[1].index).toBe(1);
    expect(result.historicalThreads[1].sendTime).toContain('2026年7月12日');
    expect(result.historicalThreads[1].content).toContain('这是第三篇很早以前的周报内容');
  });

  it('能够处理无分隔线但有发件人与发送时间字段的回帖块', () => {
    const text = `这是最新回复。

发件人: 张三 <zhangsan@test.com>
发送时间: 2026-05-01 10:00:00
收件人: 李四
主题: 沟通事宜

这是早先的内容。`;

    const result = parseEmailThread(text);
    expect(result.hasHistory).toBe(true);
    expect(result.historicalThreads.length).toBe(1);
    expect(result.latestMessage).toContain('这是最新回复。');
    expect(result.historicalThreads[0].sender).toContain('张三');
  });
});
