const puppeteer = require('puppeteer');
const { WebSocket } = require('ws');
const path = require('path');

const TARGET_URL = 'https://rapidlaunch.io/';
const WS_URL = 'ws://185.200.246.11:8765/source';
const USER_DATA_DIR = path.join(__dirname, 'user_data');

const AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyZTgwMGViMS1jNzk2LTQxZjgtYjg4YS0yNTllZTgyYmE4MDAiLCJ1c2VybmFtZSI6IndpdGhvdXRuYW1lX19fIiwiaWF0IjoxNzczNjgyMjYyLCJleHAiOjE3NzYyNzQyNjJ9._EEmBpdVcAgD2v4_I7f-jaq1QMm2PM3fJESPxvEG-J4";

async function startBot() {
    console.log('[BOT] Initialisation du moteur...');

    const browser = await puppeteer.launch({
        headless: "new",
        userDataDir: USER_DATA_DIR,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.exposeFunction('sendToLocalServer', ((payload) => {
        let ws = null;
        let queue = [];
        let reconnectTimer = null;

        function connect() {
            if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
            ws = new WebSocket(WS_URL);
            ws.on('open', () => {
                console.log("[WS] Connecté au serveur 185.200.246.11");
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                while (queue.length) {
                    ws.send(JSON.stringify(queue.shift()));
                }
            });
            ws.on('error', (err) => { console.log("[WS] Erreur:", err.message); });
            ws.on('close', () => {
                ws = null;
                if (!reconnectTimer) reconnectTimer = setTimeout(connect, 2000);
            });
        }

        connect();

        return (payload) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(payload));
            } else {
                queue.push(payload);
                if (queue.length > 50) queue.shift();
                connect();
            }
        };
    })());

    await page.exposeFunction('debugLog', (...args) => { console.log(...args); });

    console.log(`[BOT] Connexion à ${TARGET_URL}...`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => { });

    console.log('[BOT] Injection de la session...');
    await page.evaluate((token) => {
        localStorage.setItem('auth_token', token);
        localStorage.setItem('rapid-theme-selected', 'true');
        localStorage.setItem('rapid_layout_config', '{"feedPanelSize":50,"launchPanelSize":50,"showLaunchList":true}');
        window.dispatchEvent(new Event('storage'));
    }, AUTH_TOKEN);

    await page.reload({ waitUntil: 'networkidle2' });
    console.log('[BOT] Session active. Démarrage de l\'extraction...');

    await page.evaluate(() => {
        const seenTweets = new Set();

        function detectType(block) {
            // 1. Détection PRIORITAIRE (pour ne pas rater le follow/affiliate)
            if (block.querySelector('.lucide-user-plus')) return 'follow';
            if (block.querySelector('.lucide-user-minus')) return 'unfollow';
            if (block.querySelector('.lucide-trash-2')) return 'deleted';
            if (block.querySelector('.lucide-link2, .lucide-link-2')) return 'affiliate';

            // 2. Ton code d'origine (la suite)
            if (block.querySelector('.lucide-quote')) return 'quote';
            if (block.querySelector('.lucide-repeat')) return 'retweet';
            if (block.querySelector('.lucide-reply')) return 'reply';

            const headerRow = block.querySelector('.border-b.border-border.flex');
            if (headerRow) {
                const headerText = headerRow.textContent || '';
                if (/[\u2190\u21a9←↩]\s*Reply/i.test(headerText) || /\bReply\b/.test(headerText)) return 'reply';
            }
            return 'tweet';
        }

        function extractHeader(block) {
            const headerRow = block.querySelector('.border-b.border-border.flex')
                || block.querySelector('[class*="border-b"][class*="flex"]')
                || block.querySelector('.px-3.py-2')
                || block;

            const pfpEl = headerRow.querySelector('img.w-9.h-9.rounded-full')
                || headerRow.querySelector('img.rounded-full');
            const nameEl = headerRow.querySelector('button.font-semibold.text-sm')
                || headerRow.querySelector('button.font-semibold')
                || headerRow.querySelector('[class*="font-semibold"]');
            const handleEl = headerRow.querySelector('.text-muted-foreground span.truncate')
                || headerRow.querySelector('span.truncate');
            const followersEl = headerRow.querySelector('.lucide-users')?.parentElement?.querySelector('span:last-child');

            const verifiedEl = headerRow.querySelector('svg[aria-label*="Verified"], svg[aria-label*="verified"]');
            const verifiedOrg = headerRow.querySelector('svg[aria-label*="organization"], svg[aria-label*="Organization"]');
            const verifiedGov = headerRow.querySelector('svg[aria-label*="Government"], svg[aria-label*="government"]');
            let verifiedType = null;
            if (verifiedGov) verifiedType = 'government';
            else if (verifiedOrg) verifiedType = 'organization';
            else if (verifiedEl) {
                const fillAttr = verifiedEl.getAttribute('fill') || verifiedEl.getAttribute('stroke') || '';
                const style = verifiedEl.getAttribute('style') || '';
                const cls = verifiedEl.className?.baseVal || '';
                if (/E8A817|e8a817|F5A623|f5a623|gold|yellow|amber/i.test(fillAttr + style + cls)) verifiedType = 'organization';
                else if (/829AAB|829aab|gray|grey|government/i.test(fillAttr + style + cls)) verifiedType = 'government';
                else verifiedType = 'blue';
            } else {
                headerRow.querySelectorAll('svg').forEach(svg => {
                    if (verifiedType) return;
                    const f = svg.getAttribute('fill') || '';
                    const s = svg.getAttribute('stroke') || '';
                    const combined = (f + s + (svg.getAttribute('style') || '') + (svg.className?.baseVal || '')).toLowerCase();
                    if (combined.includes('1d9bf0')) verifiedType = 'blue';
                    else if (combined.includes('e8a817') || combined.includes('f5a623')) verifiedType = 'organization';
                    else if (combined.includes('829aab')) verifiedType = 'government';
                    if (!verifiedType) {
                        svg.querySelectorAll('[fill],[stroke]').forEach(el => {
                            if (verifiedType) return;
                            const ef = (el.getAttribute('fill') || '').toLowerCase();
                            const es = (el.getAttribute('stroke') || '').toLowerCase();
                            if (ef.includes('e8a817') || ef.includes('f5a623') || es.includes('e8a817')) verifiedType = 'organization';
                            else if (ef.includes('1d9bf0') || es.includes('1d9bf0')) verifiedType = 'blue';
                            else if (ef.includes('829aab') || es.includes('829aab')) verifiedType = 'government';
                        });
                    }
                });
            }

            const affiliatedEl = headerRow.querySelector('button[data-slot="tooltip-trigger"] img.w-3\\.5.h-3\\.5');
            const affiliatedPfp = affiliatedEl?.src || '';
            const affiliatedAlt = affiliatedEl?.alt || '';

            let platform = 'twitter';
            const platformImgs = headerRow.querySelectorAll('img[src*=".png"], img[alt]');
            platformImgs.forEach(img => {
                const src = img.src || img.getAttribute('src') || '';
                const alt = (img.alt || '').toLowerCase();
                if (src.includes('truth-social') || alt.includes('truth social') || alt === 'truth') platform = 'truthsocial';
                else if (src.includes('instagram') || alt.includes('instagram')) platform = 'instagram';
                else if (src.includes('bluesky') || alt.includes('bluesky')) platform = 'bluesky';
                else if (src.includes('facebook') || alt.includes('facebook')) platform = 'facebook';
            });
            if (platform === 'twitter') {
                const nameColor = (nameEl?.getAttribute('style') || '') + (nameEl?.className || '');
                if (/7e8fff|8b5cf6|6366f1|5548ee/i.test(nameColor)) platform = 'truthsocial';
            }

            return {
                pfp: pfpEl?.src || '',
                author: (nameEl?.textContent || nameEl?.innerText || '').trim(),
                at: (handleEl?.textContent || handleEl?.innerText || '').trim(),
                followers: (followersEl?.textContent || followersEl?.innerText || '').trim(),
                verified: verifiedType,
                affiliated: affiliatedAlt ? { name: affiliatedAlt, pfp: affiliatedPfp } : null,
                platform,
            };
        }

        function forceRender(el) {
            if (!el) return;
            if (el.dataset.cvDone === '1') return;
            let node = el;
            while (node && node !== document.body) {
                const cv = window.getComputedStyle(node).contentVisibility;
                if (cv === 'auto' || cv === 'hidden') {
                    node.style.contentVisibility = 'visible';
                    node.dataset.cvForced = '1';
                }
                node = node.parentElement;
            }
            el.dataset.cvDone = '1';
        }

        function restoreRender(el) {
            if (!el) return;
            delete el.dataset.cvDone;
            let node = el;
            while (node && node !== document.body) {
                if (node.dataset.cvForced) {
                    node.style.contentVisibility = '';
                    delete node.dataset.cvForced;
                }
                node = node.parentElement;
            }
        }

        function cleanUrlParams(url) {
            try {
                const u = new URL(url);
                const toDelete = [];
                for (const [k] of u.searchParams) {
                    // Supprime utb, status, utm, ref, s, t, fbclid, etc.
                    if (/^(utm|status|ref|s|t|utb|fbclid)/i.test(k)) toDelete.push(k);
                }
                toDelete.forEach(k => u.searchParams.delete(k));

                if (u.hostname.includes('x.com') || u.hostname.includes('twitter.com')) {
                    return u.origin + u.pathname;
                }
                return u.toString().replace(/\?$/, '');
            } catch (e) { return url; }
        }

        function extractText(contentArea) {
            if (!contentArea) return '';
            forceRender(contentArea);
            let textEl = null;
            for (const el of contentArea.querySelectorAll('.text-render-container')) {
                if (!el.closest('.border-l-2')) { textEl = el; break; }
            }
            if (!textEl) {
                const candidates = contentArea.querySelectorAll(
                    '.text-sm.leading-relaxed, .text-foreground.text-sm, .text-sm.leading-normal, .text-sm.leading-snug'
                );
                for (const el of candidates) {
                    if (el.closest('.border-l-2')) continue;
                    const t = el.textContent?.trim() || '';
                    if (t.length > 3) { textEl = el; break; }
                }
            }
            let txt = '';
            if (textEl) {
                forceRender(textEl);
                const clone = textEl.cloneNode(true);
                clone.querySelectorAll('.border-l-2, .mt-2.border, img, video, svg, button').forEach(n => n.remove());
                clone.querySelectorAll('a[href]').forEach(a => {
                    a.replaceWith(document.createTextNode(cleanUrlParams(a.href)));
                });
                clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                txt = clone.textContent?.trim() || '';
            } else {
                forceRender(contentArea);
                const clone = contentArea.cloneNode(true);
                clone.querySelectorAll('img, video, svg, button, .border-l-2, .mt-2.border, .rounded-lg.border').forEach(n => n.remove());
                clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                txt = clone.textContent?.trim() || '';
            }
            txt = txt.replace(/\s*Show more\s*$/i, '');
            txt = txt.replace(/https:\/\/x\.com\/i\/web\/status\/\d+/g, '');
            txt = txt.replace(/\n{3,}/g, '\n\n');
            return txt.trim();
        }

        function extractMedia(el, includeThread) {
            if (!el) return [];
            const s = new Set();
            el.querySelectorAll('img, video').forEach(v => {
                const src = v.src || v.getAttribute('src') || '';
                if (!src || src === 'undefined') return;
                if (src.includes('profile_images') || src.includes('profile_banners')) return;
                if (src === '/instagram.png' || src.includes('favicon')) return;
                const cls = v.className || '';
                if (/\bw-3\.5\b|\bw-5\b|\bw-9\b|\bw-16\b/.test(cls)) return;
                if (v.tagName === 'IMG' && v.closest('video')) return;
                if (!includeThread && v.closest('.border-l-2')) return;
                const inLinkCard = v.closest('a.flex.text-left') || v.closest('.mt-2.border.border-border.rounded-lg > a');
                if (inLinkCard) return;
                s.add(src);
            });
            return [...s];
        }

        function extractThread(block) {
            const allTc = block.querySelectorAll('.border-l-2');
            if (!allTc.length) return [];
            const directTc = [...allTc].filter(tc => {
                const parentBorder = tc.parentElement?.closest('.border-l-2');
                return !parentBorder || !block.contains(parentBorder);
            });
            if (!directTc.length) return [];

            function txt(el) {
                if (!el) return '';
                return (el.textContent || el.innerText || '').trim();
            }

            function extractOne(tc, depth) {
                forceRender(tc);
                let label = '';
                let labelUrl = '';
                const labelLink = tc.querySelector(':scope > div > a, :scope > a');
                if (labelLink) {
                    labelUrl = labelLink.href || labelLink.getAttribute('href') || '';
                    const lspan = labelLink.querySelector('span.text-xs.font-medium, span:first-child');
                    label = txt(lspan) || txt(labelLink);
                    label = label.replace(/[\u25B6\u25C0\u2190-\u21FF]/g, '').trim();
                }
                if (!label) {
                    const style = tc.getAttribute('style') || '';
                    const cls = tc.className || '';
                    if (style.includes('purple') || cls.includes('purple')) label = 'Quoting';
                    else if (style.includes('green') || cls.includes('green')) label = 'Retweeted';
                    else label = 'Replying to';
                }

                const innerRow = [...tc.querySelectorAll('.flex.items-start.gap-3')]
                    .find(el => el.closest('.border-l-2') === tc)
                    || tc.querySelector('.flex.items-start.gap-3')
                    || tc.querySelector('.flex.items-start');

                const nameEl = innerRow?.querySelector('span.font-medium.text-foreground\\/80')
                    || innerRow?.querySelector('.font-medium.text-xs.truncate')
                    || innerRow?.querySelector('span.font-medium');
                const handleEl = innerRow?.querySelector('span.text-muted-foreground.text-xs:not(.leading-relaxed)')
                    || innerRow?.querySelector('.text-muted-foreground.text-xs');
                const pfpEl = innerRow?.querySelector('img.w-5.h-5.rounded-full')
                    || tc.querySelector('img.w-5.h-5.rounded-full');

                let textEl = null;
                const textCandidates = ['.text-muted-foreground.text-xs.leading-relaxed', '.text-render-container', '.leading-relaxed', '.leading-normal', '.text-xs'];
                for (const selector of textCandidates) {
                    const found = [...tc.querySelectorAll(selector)].find(el => el.closest('.border-l-2') === tc);
                    if (found && found.textContent.trim().length > 1) { textEl = found; break; }
                }

                let threadText = '';
                if (textEl) {
                    forceRender(textEl);
                    const tClone = textEl.cloneNode(true);
                    tClone.querySelectorAll('.border-l-2, button, svg').forEach(n => n.remove());
                    tClone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                    threadText = (tClone.textContent || '').trim();
                }
                threadText = threadText.replace(/\s*Show more\s*$/i, '').replace(/\n{3,}/g, '\n\n').trim();

                const mediaSrcs = new Set();
                tc.querySelectorAll('img, video').forEach(v => {
                    if (v.closest('.border-l-2') !== tc) return;
                    const src = v.src || v.getAttribute('src') || '';
                    if (!src || src.includes('profile_images')) return;
                    mediaSrcs.add(src);
                });

                const subTc = [...tc.querySelectorAll('.border-l-2')].filter(sub => sub.parentElement?.closest('.border-l-2') === tc);
                const children = subTc.map(sub => extractOne(sub, depth + 1));

                return { label, labelUrl, author: txt(nameEl), at: txt(handleEl), pfp: pfpEl?.src || '', text: threadText, media: [...mediaSrcs], depth, children };
            }
            return directTc.map(tc => extractOne(tc, 0));
        }

        function extractProfileCard(block) {
            const card = block.querySelector('.rounded-lg.border.overflow-hidden');
            if (!card) return null;
            const bannerEl = card.querySelector('img.w-full.h-full, img.object-cover:not(.rounded-full)');
            const pfpLargeEl = card.querySelector('img.w-16.h-16.rounded-full');
            const nameEl = card.querySelector('button.font-bold.text-base');
            const handleEl = card.querySelector('p.text-muted-foreground.text-sm');
            const bioEl = card.querySelector('p.text-foreground\\/80');
            
            // Correction : Sélectionner tous les spans et extraire Following/Followers correctement
            const statsRow = card.querySelector('.flex.items-center.gap-4.mt-3');
            const statsSpans = statsRow ? Array.from(statsRow.querySelectorAll('span.text-muted-foreground')) : [];
            
            let followingCount = '0';
            let followersCount = '0';
            
            statsSpans.forEach(span => {
                const text = span.textContent || '';
                if (text.includes('Following')) {
                    const boldEl = span.querySelector('.font-bold');
                    followingCount = boldEl ? boldEl.textContent.trim() : '0';
                } else if (text.includes('Followers')) {
                    const boldEl = span.querySelector('.font-bold');
                    followersCount = boldEl ? boldEl.textContent.trim() : '0';
                }
            });
            
            return {
                banner: bannerEl?.src || '', 
                pfpLarge: pfpLargeEl?.src || '',
                name: (nameEl?.textContent || '').trim(), 
                handle: (handleEl?.textContent || '').trim(),
                bio: (bioEl?.textContent || '').trim(), 
                followingCount,
                followersCount,
            };
        }

        function extractLinkCard(block) {
            const card = block.querySelector('.mt-2.border.border-border.rounded-lg a');
            if (!card) return null;
            return {
                url: cleanUrlParams(card.href || ''), title: (card.querySelector('h4')?.textContent || '').trim(),
                description: (card.querySelector('p')?.textContent || '').trim(), image: card.querySelector('img')?.src || '',
            };
        }

        function extractMeta(block) {
            const footer = block.querySelector('.flex.items-center.border-t.border-border');
            const viewLink = footer?.querySelector('a[href*="/status/"]');
            let url = viewLink?.href || '';
            const tweetId = block.getAttribute('data-tweet-id');
            const timeEl = block.querySelector('.flex.items-center.text-\\[11px\\] span.font-medium') || footer?.querySelector('span.font-medium');
            return { url: cleanUrlParams(url), date_display: timeEl?.innerText?.trim() || '' };
        }

        function processTweetBlock(block) {
            const tweetId = block.getAttribute('data-tweet-id');
            const type = detectType(block);
            const header = extractHeader(block);

            // LA CORRECTION EST ICI :
            // On définit les types qui n'ont pas forcément un header complet
            const isAction = ['follow', 'unfollow', 'deleted', 'affiliate'].includes(type);

            // Si ce n'est PAS une action spéciale ET qu'il manque les infos, on sort.
            // Mais si c'est un 'follow' ou 'affiliate', on continue même si header est incomplet !
            if (!isAction && !header.author && !header.at && !header.pfp) return;

            const id = tweetId || `${type}_${header.at || 'action'}_${Date.now()}`;
            if (tweetId && seenTweets.has(id)) return;

            forceRender(block);
            const contentArea = block.querySelector('.p-4, .p-3, .px-4.pb-4');

            // Ton réglage : texte vide pour les retweets
            const rawText = (type === 'retweet') ? '' : extractText(contentArea);

            if (rawText.endsWith('…') || rawText.endsWith('...')) {
                restoreRender(block);
                return;
            }

            if (tweetId) seenTweets.add(id);

            const thread = extractThread(block);
            const directMedia = (type === 'retweet') ? [] : extractMedia(contentArea);

            restoreRender(block);

            const payload = {
                id, type,
                author: header.author || "Action Account",
                at: header.at || "@action",
                pfp: header.pfp,
                followers: header.followers,
                verified: header.verified,
                affiliated: header.affiliated,
                platform: header.platform || 'twitter',
                text: rawText,
                media: directMedia,
                thread,
                // C'est ici que le follow/unfollow/affiliate récupère les infos de profil
                profileCard: (type === 'follow' || type === 'unfollow' || type === 'affiliate') ? extractProfileCard(block) : null,
                linkCard: extractLinkCard(block),
                os_time: Math.floor(Date.now() / 1000),
                ...extractMeta(block),
            };

            // Sécurité pour le texte des deleted
            if (type === 'deleted' && !payload.text) payload.text = "Tweet supprimé";

            debugLog(`[EXTRACTION] ${payload.type.toUpperCase()} : ${payload.at}`);
            sendToLocalServer(payload);
        }

        const seenAt = new Map();

        setInterval(() => {
            const now = Date.now();
            const blocks = document.querySelectorAll('[data-tweet-id]');

            blocks.forEach(block => {
                const id = block.getAttribute('data-tweet-id');
                if (seenTweets.has(id)) return;

                const buttons = block.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent.toLowerCase().includes('show more')) {
                        btn.click();
                        break;
                    }
                }

                if (!seenAt.has(id)) {
                    seenAt.set(id, now);
                    return;
                }

                const age = now - seenAt.get(id);
                if (age > 300) {
                    processTweetBlock(block);
                }
            });

            if (seenAt.size > 500) {
                const cutoff = now - 60000;
                for (const [id, ts] of seenAt) { if (ts < cutoff) seenAt.delete(id); }
            }
        }, 150);
    });
}

startBot();