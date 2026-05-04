// api/weekly-report.js
// Runs every Sunday at 2pm UTC via Vercel cron.
// Emails Jordan a full maintenance status report:
// - What was completed this week
// - What's overdue
// - What's coming up in the next 30 days

import {
  getAllTasks,
  PROJECTS, JORDAN_EMAIL,
  sendEmail,
  today, addDays, daysBetween, formatDate,
} from '../lib/utils.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const todayStr    = today();
  const weekAgoStr  = addDays(todayStr, -7);
  const next30Str   = addDays(todayStr, 30);

  console.log(`[weekly-report] Generating report for week ending ${todayStr}`);

  const propertyData = {};

  for (const [propKey, projectId] of Object.entries({
    delta_dawn:   PROJECTS.delta_dawn,
    legobi_villa: PROJECTS.legobi_villa,
  })) {
    const label = propKey === 'delta_dawn' ? '🏔️ Delta Dawn' : '🏖️ LeGobi Villa';
    const tasks = await getAllTasks(projectId, 'gid,name,due_on,completed,completed_at,assignee.name');

    const completedThisWeek = tasks.filter(t =>
      t.completed && t.completed_at &&
      t.completed_at.split('T')[0] >= weekAgoStr
    );

    const overdue = tasks.filter(t =>
      !t.completed && t.due_on && t.due_on < todayStr
    ).sort((a, b) => a.due_on.localeCompare(b.due_on));

    const upcoming = tasks.filter(t =>
      !t.completed && t.due_on &&
      t.due_on >= todayStr && t.due_on <= next30Str
    ).sort((a, b) => a.due_on.localeCompare(b.due_on));

    propertyData[propKey] = { label, completedThisWeek, overdue, upcoming };
  }

  // ── Build email HTML ──────────────────────────────────────────────────────
  const totalCompleted = Object.values(propertyData).reduce((s, p) => s + p.completedThisWeek.length, 0);
  const totalOverdue   = Object.values(propertyData).reduce((s, p) => s + p.overdue.length, 0);
  const totalUpcoming  = Object.values(propertyData).reduce((s, p) => s + p.upcoming.length, 0);

  const statusColor = totalOverdue > 0 ? '#e74c3c' : '#27ae60';
  const statusLabel = totalOverdue > 0 ? `${totalOverdue} task(s) overdue` : 'All clear ✅';

  const taskRow = (t, bg = '#fff') => `
    <tr style="background:${bg}">
      <td style="padding:8px 12px;">${t.name}</td>
      <td style="padding:8px 12px; white-space:nowrap;">${t.due_on ? formatDate(t.due_on) : '—'}</td>
      <td style="padding:8px 12px;">${t.assignee?.name || '—'}</td>
    </tr>`;

  const section = (title, tasks, emptyMsg, bgAlt = '#f9f9f9') => {
    if (!tasks.length) return `
      <h3 style="margin:24px 0 8px; color:#555;">${title}</h3>
      <p style="color:#aaa; margin:0 0 16px;">${emptyMsg}</p>`;

    return `
      <h3 style="margin:24px 0 8px; color:#333;">${title}</h3>
      <table style="width:100%; border-collapse:collapse; margin-bottom:16px; font-size:14px;">
        <thead>
          <tr style="background:#f0f0f0;">
            <th style="padding:8px 12px; text-align:left;">Task</th>
            <th style="padding:8px 12px; text-align:left; white-space:nowrap;">Due Date</th>
            <th style="padding:8px 12px; text-align:left;">Assigned To</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map((t, i) => taskRow(t, i % 2 === 0 ? '#fff' : bgAlt)).join('')}
        </tbody>
      </table>`;
  };

  let propertySections = '';
  for (const { label, completedThisWeek, overdue, upcoming } of Object.values(propertyData)) {
    propertySections += `
      <div style="border:1px solid #e0e0e0; border-radius:8px; padding:16px 20px; margin-bottom:24px;">
        <h2 style="margin:0 0 16px; font-size:18px;">${label}</h2>
        ${section('✅ Completed This Week', completedThisWeek, 'Nothing completed this week.')}
        ${section('🔴 Overdue', overdue, 'No overdue tasks — nice!')}
        ${section('📅 Coming Up (Next 30 Days)', upcoming, 'Nothing scheduled in the next 30 days.')}
      </div>`;
  }

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 680px; color: #222;">
      <div style="background:#1a1a2e; color:white; padding:20px 24px; border-radius:8px 8px 0 0;">
        <h1 style="margin:0; font-size:20px;">🏡 Dwellia Weekly Maintenance Report</h1>
        <p style="margin:4px 0 0; opacity:0.7; font-size:14px;">Week ending ${formatDate(todayStr)}</p>
      </div>

      <div style="background:${statusColor}; color:white; padding:12px 24px; display:flex; justify-content:space-between;">
        <span style="font-weight:600;">${statusLabel}</span>
        <span>${totalCompleted} completed · ${totalUpcoming} upcoming</span>
      </div>

      <div style="padding:24px;">
        ${propertySections}

        <p style="color:#aaa; font-size:12px; margin-top:32px; border-top:1px solid #eee; padding-top:16px;">
          Generated by Dwellia Maintenance Scheduler · ${todayStr}<br>
          To update the schedule, edit tasks in the <strong>🗓️ Maintenance Schedule Config</strong> project in Asana.
        </p>
      </div>
    </div>`;

  const text = `Dwellia Weekly Maintenance Report — ${todayStr}
Status: ${statusLabel}
Completed this week: ${totalCompleted} | Upcoming: ${totalUpcoming}

${Object.values(propertyData).map(({ label, completedThisWeek, overdue, upcoming }) => `
${label}
Completed: ${completedThisWeek.map(t => t.name).join(', ') || 'None'}
Overdue:   ${overdue.map(t => `${t.name} (${t.due_on})`).join(', ') || 'None'}
Upcoming:  ${upcoming.map(t => `${t.name} (${t.due_on})`).join(', ') || 'None'}
`).join('\n')}`;

  await sendEmail({
    to:      JORDAN_EMAIL,
    subject: `🏡 Dwellia Maintenance Report — ${formatDate(todayStr)}`,
    html,
    text,
  });

  console.log(`[weekly-report] Report sent to ${JORDAN_EMAIL}`);
  return res.status(200).json({ success: true, date: todayStr, totalCompleted, totalOverdue, totalUpcoming });
}
