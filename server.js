const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    cookie: { maxAge: 86400000 },
    store: new MemoryStore({ checkPeriod: 86400000 }),
    secret: 'nemonics_super_secret_key',
    resave: false,
    saveUninitialized: false
}));

// Helper function for IST Date (YYYY-MM-DD)
function getTodayIST() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Authentication Middleware
function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).json({ error: 'Forbidden' });
}

// --- HTML PAGE ROUTES ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/user', isAuthenticated, (req, res) => {
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    res.sendFile(path.join(__dirname, 'public', 'user.html'));
});
app.get('/admin', isAdmin, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

// --- AUTH API ROUTES ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .eq('password', password)
            .limit(1);

        if (error || !users || users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

        req.session.user = users[0];
        res.json({ success: true, role: users[0].role });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });

app.get('/api/me', isAuthenticated, async (req, res) => {
    try {
        const { data: currentUser } = await supabase
            .from('users')
            .select('*')
            .eq('id', req.session.user.id)
            .single();
        if (currentUser) req.session.user = currentUser;
    } catch(e) {}
    res.json(req.session.user);
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const { data: users, error } = await supabase.from('users').select('id, username, role, rate_per_install');
        if (error) return res.status(500).json({ error: error.message });

        // Fetch all links to calculate total installs per user dynamically
        const { data: links } = await supabase.from('links').select('user_id, installs');
        
        const userInstallsMap = {};
        if (links) {
            links.forEach(l => {
                if (!userInstallsMap[l.user_id]) userInstallsMap[l.user_id] = 0;
                userInstallsMap[l.user_id] += (l.installs || 0);
            });
        }

        const enrichedUsers = users.map(u => ({
            ...u,
            total_installs: userInstallsMap[u.id] || 0
        }));

        res.json(enrichedUsers);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Update User Rate per install
app.post('/api/admin/set-rate', isAdmin, async (req, res) => {
    const { userId, rate } = req.body;
    try {
        const { error } = await supabase
            .from('users')
            .update({ rate_per_install: parseFloat(rate) || 0 })
            .eq('id', userId);

        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Process Custom Payout / Reset or Adjust Installs with Log Entry
app.post('/api/admin/pay/:userId', isAdmin, async (req, res) => {
    const userId = req.params.userId;
    const { amount_paid, note } = req.body;
    try {
        // Reset user installs or process payout balance
        const { error } = await supabase
            .from('users')
            .update({ total_installs: 0 }) 
            .eq('id', userId);

        if (error) return res.status(500).json({ error: error.message });

        // Save entry in payout logs table if table exists
        await supabase.from('payout_logs').insert([{
            user_id: parseInt(userId),
            amount: parseFloat(amount_paid) || 0,
            note: note || 'Payout Processed'
        }]).select();

        res.json({ success: true, message: 'Payment recorded and balance updated' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// --- NEW: Deduct Balance / Installs Route ---
app.post('/api/admin/deduct/:userId', isAdmin, async (req, res) => {
    const userId = req.params.userId;
    const { amount_deducted, note } = req.body;
    
    try {
        const { data: user, error: userErr } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();

        if (userErr || !user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Save entry with negative amount in payout logs to indicate deduction
        await supabase.from('payout_logs').insert([{
            user_id: parseInt(userId),
            amount: -Math.abs(parseFloat(amount_deducted) || 0),
            note: note ? `Deduction: ${note}` : 'Amount/Balance Deducted'
        }]).select();

        res.json({ success: true, message: 'Deduction recorded successfully' });
    } catch (err) {
        console.error("Deduction error:", err);
        res.status(500).json({ error: 'Server error while processing deduction' });
    }
});

// --- ADMIN PAYOUT LOGS API ROUTE ---
app.get('/api/admin/payout-logs', isAdmin, async (req, res) => {
    try {
        const { data: logs, error } = await supabase
            .from('payout_logs')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            // If table doesn't exist yet, return empty array gracefully
            return res.json([]);
        }

        res.json(logs || []);
    } catch (err) {
        res.status(500).json({ error: 'Server error while fetching payout logs' });
    }
});

app.post('/api/admin/set-link-rate', isAdmin, async (req, res) => {
    const { link_id, rate } = req.body;
    try {
        const { error } = await supabase
            .from('links')
            .update({ rate_per_install: parseFloat(rate) || 0 })
            .eq('id', link_id);

        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true, message: 'Link rate updated successfully' });
    } catch (err) { 
        res.status(500).json({ error: 'Failed to update link rate' }); 
    }
});

app.post('/api/admin/create-user', isAdmin, async (req, res) => {
    const { username, password } = req.body;
    const { data, error } = await supabase
        .from('users')
        .insert([{ username, password, role: 'user', total_installs: 0, rate_per_install: 0 }]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, data });
});

app.post('/api/admin/assign-links', isAdmin, async (req, res) => {
    const { user_id, items } = req.body;
    if (!user_id || !items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid data format received' });
    }
    try {
        for (let item of items) {
            const shortCode = Math.random().toString(36).substring(2, 8);
            const cleanUrl = item.url ? item.url.trim() : '';
            await supabase.from('links').insert([{
                user_id: parseInt(user_id),
                link_name: item.name || 'Direct Link',
                target_url: cleanUrl,
                short_code: shortCode,
                clicks: 0,
                installs: 0,
                rate_per_install: parseFloat(item.rate) || 0
             }]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// --- ADMIN ALL-LINKS API ---
app.get('/api/admin/all-links', isAdmin, async (req, res) => {
    try {
        const { data: links, error: linkError } = await supabase.from('links').select('*').order('created_at', { ascending: false });
        if (linkError) return res.status(500).json({ error: linkError.message });
        
        const { data: users, error: userError } = await supabase.from('users').select('id, username');
        if (userError) return res.status(500).json({ error: userError.message });
        
        const userMap = {};
        if (users) users.forEach(u => { userMap[u.id] = u.username; });

        const { data: allDailyStats } = await supabase.from('daily_stats').select('link_id, clicks, installs');
        const totalsMap = {};
        if (allDailyStats) {
            allDailyStats.forEach(d => {
                if (!totalsMap[d.link_id]) {
                    totalsMap[d.link_id] = { clicks: 0, installs: 0 };
                }
                totalsMap[d.link_id].clicks += (d.clicks || 0);
                totalsMap[d.link_id].installs += (d.installs || 0);
            });
        }

        const todayStr = getTodayIST();
        const { data: dailyStats } = await supabase.from('daily_stats').select('*').eq('stat_date', todayStr);
        const dailyMap = {};
        if (dailyStats) {
            dailyStats.forEach(d => {
                dailyMap[d.link_id] = { clicks: d.clicks || 0, installs: d.installs || 0 };
            });
        }

        const enrichedLinks = links.map(link => {
            const totalStats = totalsMap[link.id] || { clicks: link.clicks || 0, installs: link.installs || 0 };
            return { 
                ...link, 
                clicks: totalStats.clicks > 0 ? totalStats.clicks : (link.clicks || 0),
                installs: totalStats.installs > 0 ? totalStats.installs : (link.installs || 0),
                username: userMap[link.user_id] || 'Unassigned',
                today_clicks: dailyMap[link.id] ? dailyMap[link.id].clicks : 0,
                today_installs: dailyMap[link.id] ? dailyMap[link.id].installs : 0
            };
        });

        res.json(enrichedLinks);
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/adjust-stats', isAdmin, async (req, res) => {
    const { link_id, clicks, installs } = req.body;
    const { error } = await supabase.from('links').update({ clicks: parseInt(clicks), installs: parseInt(installs) }).eq('id', link_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// Delete Link API Route
app.post('/api/admin/delete-link', isAdmin, async (req, res) => {
    const { link_id } = req.body;
    try {
        const { error } = await supabase.from('links').delete().eq('id', link_id);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// --- USER LINKS API WITH DATE RANGE FILTER ---
app.get('/api/user/links', isAuthenticated, async (req, res) => {
    const userId = req.session.user.id;
    let { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'Start date and End date are required' });
    }

    try {
        const { data: links, error } = await supabase
            .from('links')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error("Links fetch error:", error);
            return res.status(500).json({ error: error.message });
        }
        
        let dailyMap = {};

        const { data: dailyStats } = await supabase
            .from('daily_stats')
            .select('*')
            .eq('user_id', userId)
            .gte('stat_date', startDate)
            .lte('stat_date', endDate);

        if (dailyStats) {
            dailyStats.forEach(d => {
                if (!dailyMap[d.link_id]) {
                    dailyMap[d.link_id] = { clicks: 0, installs: 0 };
                }
                dailyMap[d.link_id].clicks += (d.clicks || 0);
                dailyMap[d.link_id].installs += (d.installs || 0);
            });
        }

        let totalClicks = 0, totalInstalls = 0, totalEarnings = 0;

        const enrichedLinks = links.map(l => {
            const stats = dailyMap[l.id] || { clicks: 0, installs: 0 };
            const c = stats.clicks;
            const i = stats.installs;

            const linkRate = Number(l.rate_per_install || req.session.user.rate_per_install || 0);

            totalClicks += c;
            totalInstalls += i;
            totalEarnings += (i * linkRate);

            return {
                ...l,
                clicks: c,
                installs: i,
                today_clicks: c,
                today_installs: i
            };
        });

        res.json({ 
            links: enrichedLinks, 
            stats: { totalClicks, totalInstalls, totalEarnings } 
        });
    } catch (err) { 
        console.error("User links API error:", err);
        res.status(500).json({ error: 'Server error' }); 
    }
});

// --- SHORT URL REDIRECT ROUTE ---
app.get('/s/:shortCode', async (req, res) => {
    try {
        const shortCode = req.params.shortCode;
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

        const { data: link, error: linkErr } = await supabase
          .from('links')
          .select('*')
          .eq('short_code', shortCode)
          .single();

        if (linkErr || !link || !link.target_url) {
            return res.status(404).send('Link not found or expired.');
        }

        const targetUrl = link.target_url.trim();

        await supabase.from('link_clicks').insert([{ link_id: link.id, ip_address: clientIp }]);
        await supabase.from('links').update({ clicks: (link.clicks || 0) + 1 }).eq('id', link.id);

        const todayStr = getTodayIST();

        const { data: existingDaily } = await supabase
            .from('daily_stats')
            .select('id, clicks')
            .eq('link_id', link.id)
            .eq('stat_date', todayStr)
            .maybeSingle();

        if (existingDaily) {
            await supabase
                .from('daily_stats')
                .update({ clicks: (existingDaily.clicks || 0) + 1 })
                .eq('id', existingDaily.id);
        } else {
            await supabase
                .from('daily_stats')
                .insert([{
                    link_id: link.id,
                    user_id: link.user_id,
                    clicks: 1,
                    installs: 0,
                    stat_date: todayStr
                }]);
        }

        return res.redirect(targetUrl);
    } catch (err) {
        console.error("Redirect error:", err);
        res.status(500).send('Server Error');
    }
});

// --- ADMIN EDIT / UPSERT DAILY STATS ---
app.post('/api/admin/edit-daily-stats', isAdmin, async (req, res) => {
    const { link_id, user_id, stat_date, clicks, installs } = req.body;

    if (!link_id || !stat_date) {
        return res.status(400).json({ error: 'Link ID and Stat Date are required' });
    }

    try {
        const newClicks = parseInt(clicks) || 0;
        const newInstalls = parseInt(installs) || 0;

        const { data: existing } = await supabase
            .from('daily_stats')
            .select('id')
            .eq('link_id', link_id)
            .eq('stat_date', stat_date)
            .maybeSingle();

        if (existing) {
            await supabase
                .from('daily_stats')
                .update({ clicks: newClicks, installs: newInstalls })
                .eq('id', existing.id);
        } else {
            await supabase
                .from('daily_stats')
                .insert([{
                    link_id: parseInt(link_id),
                    user_id: parseInt(user_id),
                    stat_date: stat_date,
                    clicks: newClicks,
                    installs: newInstalls
                }]);
        }

        const { data: allStats, error: sumErr } = await supabase
            .from('daily_stats')
            .select('clicks, installs')
            .eq('link_id', link_id);

        if (!sumErr && allStats) {
            let totalLinkClicks = 0;
            let totalLinkInstalls = 0;

            allStats.forEach(s => {
                totalLinkClicks += (s.clicks || 0);
                totalLinkInstalls += (s.instils || 0);
            });

            await supabase
                .from('links')
                .update({ 
                    clicks: totalLinkClicks, 
                    installs: totalLinkInstalls 
                })
                .eq('id', link_id);
        }

        res.json({ success: true, message: 'Daily stats updated and lifetime totals synced successfully!' });
    } catch (err) {
        console.error("Edit daily stats error:", err);
        res.status(500).json({ error: 'Server error while editing stats' });
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
}

module.exports = app;
