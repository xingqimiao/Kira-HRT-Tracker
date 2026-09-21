import React, { useEffect, useRef, useState } from 'react';

interface CreditsRollProps {
    onClose: () => void;
}

/**
 * 开发者彩蛋与开源致谢片尾 (Credits Roll)
 *
 * 纯黑全屏、自动缓入缓出、统一字体字号的电影片尾字幕。
 * 无杂项装饰，纯粹依靠文字与呼吸感自然上浮。
 * 点击屏幕任意处或按 Esc 键即可优雅缓退。
 */
export const CreditsRoll: React.FC<CreditsRollProps> = ({ onClose }) => {
    // 缓入缓出控制
    const [opacity, setOpacity] = useState<number>(0);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const animFrameIdRef = useRef<number | null>(null);
    const isExitingRef = useRef<boolean>(false);

    // 缓出退出处理
    const handleExit = () => {
        if (isExitingRef.current) return;
        isExitingRef.current = true;
        setOpacity(0);
        setTimeout(() => {
            onClose();
        }, 1000);
    };

    // 自动缓入
    useEffect(() => {
        const timer = setTimeout(() => {
            setOpacity(1);
        }, 50);
        return () => clearTimeout(timer);
    }, []);

    // 键盘 Esc 监听
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                handleExit();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // 自动慢速平滑滚动引擎
    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        // prefers-reduced-motion 支持
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return;
        }

        let lastTimestamp = performance.now();
        const scrollSpeedPxPerSec = 26; // 匀速平缓的电影片尾上移速度

        const step = (now: number) => {
            const deltaMs = now - lastTimestamp;
            lastTimestamp = now;

            if (!isExitingRef.current && container) {
                const maxScroll = container.scrollHeight - container.clientHeight;
                if (container.scrollTop < maxScroll) {
                    container.scrollTop += (scrollSpeedPxPerSec * deltaMs) / 1000;
                }
            }

            animFrameIdRef.current = requestAnimationFrame(step);
        };

        animFrameIdRef.current = requestAnimationFrame(step);

        return () => {
            if (animFrameIdRef.current) {
                cancelAnimationFrame(animFrameIdRef.current);
            }
        };
    }, []);

    return (
        <div
            onClick={handleExit}
            className="fixed inset-0 z-[100] bg-black text-[#e4e4e7] font-sans text-sm md:text-base select-none cursor-pointer transition-opacity duration-1000 ease-in-out overflow-hidden"
            style={{ opacity }}
        >
            <div
                ref={scrollContainerRef}
                className="w-full h-full overflow-y-auto px-6 md:px-12 text-center [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                style={{
                    maskImage: 'linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)',
                    WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)',
                }}
            >
                {/* 顶部留白 */}
                <div className="h-[45vh]" />

                <div className="max-w-xl mx-auto space-y-24 leading-relaxed tracking-wider">
                    {/* 第一幕 */}
                    <div className="space-y-6">
                        <p>Kira HRT Tracker</p>
                        <p className="text-[#a1a1aa]">开源致谢</p>
                        <div className="h-12" />
                        <p>你找到这里了。</p>
                        <div className="h-4" />
                        <p className="text-[#a1a1aa]">这里没有什么隐藏功能。</p>
                        <div className="h-4" />
                        <p className="text-[#71717a]">……</p>
                        <div className="h-4" />
                        <p>大概。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第二幕 */}
                    <div className="space-y-6">
                        <p>它以前不是现在这样。</p>
                        <div className="h-8" />
                        <p>那时候，它只是一个运行在浏览器里的网页。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">有像素风。</p>
                        <p className="text-[#a1a1aa]">有一只猫。</p>
                        <p className="text-[#a1a1aa]">有 Cloudflare Worker。</p>
                        <p className="text-[#a1a1aa]">有 D1。</p>
                        <p className="text-[#a1a1aa]">有 R2。</p>
                        <p className="text-[#a1a1aa]">有 Wrangler。</p>
                        <p className="text-[#a1a1aa]">还有一些后来已经不存在的东西。</p>
                        <div className="h-8" />
                        <p>它们后来都被删掉了。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">不是因为它们不好。</p>
                        <div className="h-4" />
                        <p>只是因为项目要去别的地方了。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第三幕 */}
                    <div className="space-y-6">
                        <p className="text-[#71717a]">worker.ts 删除。</p>
                        <p className="text-[#71717a]">Cloudflare D1 删除。</p>
                        <p className="text-[#71717a]">R2 删除。</p>
                        <div className="h-8" />
                        <p>server/ 出现了。</p>
                        <div className="h-6" />
                        <p>Node.js。</p>
                        <p>PostgreSQL。</p>
                        <p>SQL Schema。</p>
                        <p>Application Core。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">AccountService。</p>
                        <p className="text-[#a1a1aa]">MedicationService。</p>
                        <p className="text-[#a1a1aa]">LabService。</p>
                        <p className="text-[#a1a1aa]">TimelineService。</p>
                        <p className="text-[#a1a1aa]">PKSimulationService。</p>
                        <div className="h-8" />
                        <p>前端只是开始。</p>
                        <p>真正复杂的东西，开始藏到服务器后面。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第四幕 */}
                    <div className="space-y-6">
                        <p>然后，它学会了一件新的事情。</p>
                        <div className="h-4" />
                        <p>和 AI 说话。</p>
                        <div className="h-8" />
                        <p className="text-[#a1a1aa]">MCP (Model Context Protocol)。</p>
                        <p className="text-[#a1a1aa]">Streamable HTTP 与 stdio。</p>
                        <p className="text-[#a1a1aa]">Agent Access Token。</p>
                        <p className="text-[#a1a1aa]">Claude Desktop · Cursor · VS Code。</p>
                        <div className="h-8" />
                        <p>它不再只是等待人来点击按钮。</p>
                        <p>在用户授权下，它开始允许其他程序参与记录和查询。</p>
                        <div className="h-8" />
                        <p className="text-[#a1a1aa]">数据猫：</p>
                        <p>「所以现在 AI 也能找到我了？」</p>
                        <div className="h-2" />
                        <p className="text-[#71717a]">…… 是的。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第五幕 */}
                    <div className="space-y-6">
                        <p>但有些事情，不能因为看起来很漂亮，就把它写进软件。</p>
                        <div className="h-8" />
                        <p>有些药物可以记录。</p>
                        <p>但不是所有药物，都应该被画成一条浓度曲线。</p>
                        <div className="h-6" />
                        <p>醋酸环丙孕酮。</p>
                        <p>螺内酯。</p>
                        <p>比卡鲁胺。</p>
                        <div className="h-6" />
                        <p>记录，可以。</p>
                        <p>虚构一个等效浓度，不可以。</p>
                        <div className="h-8" />
                        <p className="text-[#a1a1aa]">泌乳素。ALT。AST。血钾。</p>
                        <p className="text-[#a1a1aa]">复查时钟。异常警示。用药历史。随访监测。</p>
                        <div className="h-8" />
                        <p>不是为了让页面看起来更专业。</p>
                        <p>是因为这些东西本来就值得被认真记录。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第六幕 */}
                    <div className="space-y-6">
                        <p>记录一件事情，和替它下结论，是两回事。</p>
                        <div className="h-8" />
                        <p>软件可以帮你保存数据。</p>
                        <p>可以帮你计算。</p>
                        <p>可以帮你提醒。</p>
                        <p>可以帮你整理化验单。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">但它不应该假装自己是医生。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第七幕 */}
                    <div className="space-y-6">
                        <p>有时候，一张纸上有很多数字。</p>
                        <div className="h-4" />
                        <p>雌二醇。睾酮。孕酮。……</p>
                        <div className="h-6" />
                        <p>所以让电脑帮忙看一眼。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">本地运行。用来预填。用户确认之前，不落库。</p>
                        <div className="h-8" />
                        <p className="text-[#a1a1aa]">数据猫：</p>
                        <p>「我只负责帮你找数字。」</p>
                        <p>「剩下的，你自己看看。」</p>
                    </div>

                    <div className="h-28" />

                    {/* 第八幕 */}
                    <div className="space-y-6">
                        <p>还有一些东西，不应该被随便看到。</p>
                        <div className="h-8" />
                        <p className="text-[#a1a1aa]">每条记录。独立数据密钥。AES-256-GCM。Sealed Payload。</p>
                        <div className="h-8" />
                        <p>数据库泄漏，不应该意味着所有记录一起裸奔。</p>
                        <div className="h-6" />
                        <p className="text-[#71717a]">这不是零知识客户端解密。</p>
                        <p className="text-[#71717a]">因为服务端仍然需要在用户授权下，为 MCP 提供数据访问能力。</p>
                        <div className="h-8" />
                        <p>安全不是一句口号。它是边界。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第九幕 */}
                    <div className="space-y-6">
                        <p>后来，它开始说不同的语言。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">简体中文。繁体中文。粤语。English。日本語。한국어。Türkçe。</p>
                        <div className="h-8" />
                        <p>但代码里最害怕的一件事，还是漏翻译。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">CI：「没有翻译。拒绝通过。」</p>
                        <p>数据猫：「……好严格。」</p>
                    </div>

                    <div className="h-28" />

                    {/* 第十幕 */}
                    <div className="space-y-6">
                        <p>27 / 27 全部通过。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">PostgreSQL。MCP。握手成功。服务启动。测试通过。</p>
                        <div className="h-8" />
                        <p>可以上线了吗？</p>
                        <div className="h-4" />
                        <p className="text-[#71717a]">…… 再测一次。</p>
                        <div className="h-4" />
                        <p className="text-[#a1a1aa]">还是全部通过。</p>
                        <div className="h-6" />
                        <p>好吧。这次真的可以了。</p>
                        <div className="h-2" />
                        <p>数据猫：「我批准。」</p>
                    </div>

                    <div className="h-28" />

                    {/* 第十一幕 */}
                    <div className="space-y-6">
                        <p>这里曾经发生过一些事情。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">BUG #001</p>
                        <p className="text-[#a1a1aa]">原本只是想改一个地方，最后重写了半个系统。</p>
                        <div className="h-6" />
                        <p>开发者：「我就改一行。」</p>
                        <div className="h-4" />
                        <p className="text-[#71717a]">三个小时后。git diff</p>
                        <p className="text-[#a1a1aa]">+39,258  -13,666</p>
                        <div className="h-8" />
                        <p>很多东西被删掉了。很多东西重新长出来了。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第十二幕 */}
                    <div className="space-y-6">
                        <p className="text-[#a1a1aa]">前端重写。后端重写。数据层重写。</p>
                        <p className="text-[#a1a1aa]">账户系统重写。同步系统重写。MCP 加入。</p>
                        <p className="text-[#a1a1aa]">隐私架构重构。医学逻辑重构。UI 重构。多语言重构。</p>
                        <div className="h-8" />
                        <p>很多东西消失了。很多东西出现了。</p>
                        <div className="h-4" />
                        <p className="text-[#71717a]">那只原来的像素猫，也没有留下来。</p>
                        <div className="h-8" />
                        <p>但有一样东西没有被重写。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第十三幕 */}
                    <div className="space-y-6">
                        <p>数学。</p>
                        <div className="h-6" />
                        <p>三室开放模型。双相肌注吸收动力学。舌下含服模型。</p>
                        <div className="h-8" />
                        <p>这些方程，有自己的来处。</p>
                        <div className="h-4" />
                        <p>它们不是我们第一次写下的。</p>
                        <p>我们只是把它们，带到了一个新的项目里。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第十四幕 */}
                    <div className="space-y-6">
                        <p>还有一件事。</p>
                        <div className="h-6" />
                        <p>在复用这部分工作之前，我们联系了原作者。</p>
                        <div className="h-4" />
                        <p>对方回复了。</p>
                        <div className="h-4" />
                        <p>可以。</p>
                        <div className="h-8" />
                        <p>很多时候，开源并不是什么宏大的东西。</p>
                        <div className="h-4" />
                        <p>它可能只是一个开发者，回复了另一个开发者的一封消息。</p>
                        <div className="h-4" />
                        <p>然后，一份已经存在的工作，又开始了下一段旅程。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第十五幕 */}
                    <div className="space-y-6">
                        <p>致敬所有留下基石的人</p>
                        <div className="h-8" />
                        <div className="space-y-4 text-[#a1a1aa]">
                            <p>药代动力学模型：HRT-Recorder-PKcomponent-Test</p>
                            <p>作者：Mihari (@LaoZhong-Mihari) · 非商业使用授权</p>
                            <div className="h-4" />
                            <p>上游基础网页：Oyama&apos;s HRT Tracker</p>
                            <p>作者：Joseph Smirnova Oyama (@xunxunProjects) · MIT License</p>
                            <div className="h-4" />
                            <p>数据库：PostgreSQL · PostgreSQL Global Development Group</p>
                            <p>服务端与运行时：Node.js · Node.js Contributors</p>
                            <p>协议实现：Model Context Protocol SDK · Anthropic PBC</p>
                            <p>边缘文字识别：Tesseract.js · Tesseract OCR Engine</p>
                            <p>前端基石：React · Vite · Tailwind CSS · Reicon · jsPDF</p>
                        </div>
                    </div>

                    <div className="h-28" />

                    {/* 第十六幕 */}
                    <div className="space-y-6">
                        <p>Oyama&apos;s HRT Tracker</p>
                        <p className="text-[#71717a]">↓</p>
                        <p>Kira HRT Tracker</p>
                        <div className="h-8" />
                        <p>不是简单复制。也不是从零开始。</p>
                        <p>是从一个已经存在的东西，继续往前走。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">原项目留下了起点。</p>
                        <p className="text-[#a1a1aa]">Kira HRT Tracker 重写了大量架构、服务端、界面与功能。</p>
                        <p className="text-[#a1a1aa]">但那些继续被使用的底层工作，仍然属于它们原来的来处。</p>
                        <div className="h-6" />
                        <p>所以我们把名字留下来。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第十七幕 */}
                    <div className="space-y-6">
                        <p>一开始，它只是一个记录用药的小工具。</p>
                        <div className="h-4" />
                        <p className="text-[#a1a1aa]">一支药。一个时间。一次化验。一条曲线。</p>
                        <div className="h-8" />
                        <p>后来它变得复杂。</p>
                        <div className="h-4" />
                        <p>但这些东西，最后还是在记录同一件事情。</p>
                        <div className="h-6" />
                        <p>一个人的生活。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第十八幕 */}
                    <div className="space-y-6">
                        <p>有人在第一次打开 HRT 记录器。</p>
                        <div className="h-4" />
                        <p>有人在第一次认真记录自己的身体。</p>
                        <div className="h-4" />
                        <p>有人在医院走廊里，攥着一张化验单。</p>
                        <div className="h-4" />
                        <p>有人在凌晨，搜索一个自己已经看过很多遍的问题。</p>
                        <div className="h-6" />
                        <p>有人第一次认真问自己：「我是不是也可以这样生活？」</p>
                        <div className="h-8" />
                        <p className="text-[#a1a1aa]">他们可能互不认识。生活也许完全不同。</p>
                        <p className="text-[#a1a1aa]">但他们都曾经在某个地方，找到过彼此。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第十九幕 */}
                    <div className="space-y-6">
                        <p>看起来，这些都只是数据。</p>
                        <div className="h-4" />
                        <p>可数据的后面，总是有人。</p>
                        <div className="h-8" />
                        <p className="text-[#a1a1aa]">一项化验结果后面，有一个正在生活的人。</p>
                        <p className="text-[#a1a1aa]">一次用药记录后面，有一个正在摸索自己身体的人。</p>
                        <p className="text-[#a1a1aa]">一份调查问卷后面，也从来不只是一个统计数字。</p>
                        <p>它后面，是一个真的填写过答案的人。</p>
                        <div className="h-8" />
                        <p>所以，我们记录的从来不只是激素。</p>
                        <p>也不只是数字。更不是一张漂亮的曲线。</p>
                        <div className="h-6" />
                        <p>我们记录的，是一些人正在成为自己。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第二十幕 */}
                    <div className="space-y-4">
                        <p>一次认真听完的话。</p>
                        <p>一次不被打断的自我介绍。</p>
                        <p>一个被正确称呼的名字。</p>
                        <p>一份不会因为害怕而藏起来的病历。</p>
                        <p>一间可以放心进去的诊室。</p>
                        <p>一个知道自己并不孤单的晚上。</p>
                        <div className="h-10" />
                        <p>有时候，所谓“关怀”并不是什么巨大的事情。</p>
                        <div className="h-2" />
                        <p>只是有人愿意认真对待另一个人的存在。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第二十一幕 */}
                    <div className="space-y-6">
                        <p>或许开源也是这样。</p>
                        <div className="h-6" />
                        <p>有人把自己做过的东西留下来。</p>
                        <p>后来的人，接住它。</p>
                        <p className="text-[#71717a]">改一改。补一点。修一个问题。再留下去。</p>
                        <div className="h-8" />
                        <p>于是，一个人写下的东西，变成了很多人可以继续使用的东西。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">代码如此。知识如此。经验如此。关怀，也应该如此。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第二十二幕 */}
                    <div className="space-y-6">
                        <p>我们不追求制造一个漂亮的答案。</p>
                        <div className="h-6" />
                        <p>我们更希望留下：</p>
                        <p>足够可靠的问题。</p>
                        <p>足够诚实的证据。</p>
                        <p>足够长久的记录。</p>
                        <div className="h-8" />
                        <p>因为一个真实的问题，有时候比一个漂亮的答案，更值得被留下。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第二十三幕 */}
                    <div className="space-y-6">
                        <p>也许某一天，这个项目会被另一个人接着修改。</p>
                        <div className="h-4" />
                        <p>也许某一天，会有人发现我们今天写下的东西，其实也可以做得更好。</p>
                        <div className="h-6" />
                        <p>那很好。</p>
                        <div className="h-8" />
                        <p>因为留下东西，从来不是为了让它永远属于自己。</p>
                        <div className="h-4" />
                        <p>而是希望它在自己离开之后，还能稍微帮到一个人。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第二十四幕 */}
                    <div className="space-y-4">
                        <p>有人写出了算法。</p>
                        <p>有人公开了代码。</p>
                        <p>有人维护了依赖。</p>
                        <p>有人认真写了文档。</p>
                        <p>有人把服务器跑了起来。</p>
                        <p>有人发现问题。</p>
                        <p>有人修掉问题。</p>
                        <p>有人回答了一封邮件。</p>
                        <p>有人继续往下写。</p>
                        <div className="h-10" />
                        <p>我们只是把这些东西，接到了一起。</p>
                        <div className="h-6" />
                        <p>于是，Kira HRT Tracker 出现了。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第二十五幕 */}
                    <div className="space-y-4">
                        <p>感谢写下代码的人。</p>
                        <p>感谢分享知识的人。</p>
                        <p>感谢维护开源项目的人。</p>
                        <p>感谢认真填写问卷的人。</p>
                        <p>感谢愿意讲述自己经历的人。</p>
                        <p>感谢那个在陌生人的问题下面，认真写下回答的人。</p>
                        <div className="h-10" />
                        <p>也感谢每一个，让另一个人稍微觉得世界没那么冷的人。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第二十六幕 */}
                    <div className="space-y-6">
                        <p>如果有一天，</p>
                        <div className="h-2" />
                        <p>那些今天还需要一遍又一遍证明自己“确实经历过”的人，不再需要证明了。</p>
                        <div className="h-6" />
                        <p>如果有一天，</p>
                        <p>一个人只是很平静地生活，而不必先向这个世界解释，自己为什么值得被认真对待。</p>
                        <div className="h-8" />
                        <p>那大概，就是这些记录最终能够去到的地方。</p>
                        <div className="h-4" />
                        <p className="text-[#a1a1aa]">不是答案。只是让下一次提问，拥有更多真实的东西。</p>
                    </div>

                    <div className="h-28" />

                    {/* 第二十七幕 */}
                    <div className="space-y-6">
                        <p>愿每一个正在寻找自己的人，都能找到一点可以依靠的东西。</p>
                        <div className="h-6" />
                        <p className="text-[#a1a1aa]">一份资料。</p>
                        <p className="text-[#a1a1aa]">一个社区。</p>
                        <p className="text-[#a1a1aa]">一位愿意认真听你说话的人。</p>
                        <div className="h-4" />
                        <p className="text-[#71717a]">或者，</p>
                        <p>一只愿意安静陪着你的数据猫。</p>
                        <div className="h-6" />
                        <p>🐈</p>
                    </div>

                    <div className="h-28" />

                    {/* 第二十八幕 */}
                    <div className="space-y-6">
                        <p className="text-[#71717a]">……</p>
                        <div className="h-4" />
                        <p className="text-[#a1a1aa]">数据猫：</p>
                        <p>「所以我们到底在记录什么？」</p>
                        <div className="h-6" />
                        <p className="text-[#71717a]">……</p>
                        <div className="h-4" />
                        <p>「嗯。」</p>
                        <p>「先记录下来吧。」</p>
                        <div className="h-4" />
                        <p>🐈</p>
                    </div>

                    <div className="h-36" />

                    {/* 终章 */}
                    <div className="space-y-8">
                        <p>Kira HRT Tracker</p>
                        <div className="h-4" />
                        <p>记录身体，也记得人。</p>
                        <div className="h-12" />
                        <p>愿你有一天，可以很平静地成为自己。</p>
                    </div>

                    <div className="h-36" />

                    {/* 尾声 */}
                    <div className="space-y-6 pb-32 text-[#71717a]">
                        <p>感谢你看到这里。</p>
                        <div className="h-2" />
                        <p>（点击任意处退出）</p>
                        <div className="h-4" />
                        <p>🐈</p>
                    </div>
                </div>

                {/* 底部缓冲 */}
                <div className="h-[45vh]" />
            </div>
        </div>
    );
};
