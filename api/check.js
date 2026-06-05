const ASANA_TOKEN = process.env.ASANA_TOKEN;
const WORKSPACE_GID = process.env.ASANA_WORKSPACE_GID;
const ALERT_HOURS = parseInt(process.env.ALERT_HOURS || '24');
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const CC_EMAIL = 'alicia@pow.la';

const TEAM = [
  { email: 'brenda@pow.la', name: 'Brenda' },
  { email: 'florencia@pow.la', name: 'Florencia' },
  { email: 'martina.arias@pow.la', name: 'Martina' },
  { email: 'luciana@pow.la', name: 'Luciana' },
];

async function asanaGet(path) {
  const res = await fetch(`https://app.asana.com/api/1.0${path}`, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function sendEmail(to, name, mentions, overdue) {
  const mentionRows = mentions.map(a =>
    `<tr><td style="padding:10px 12px;border-bottom:1px solid #f0ede8;">
      <a href="https://app.asana.com/0/${a.projectGid}/${a.taskGid}" style="color:#FF722D;font-weight:500;">${a.taskName}</a>
      <div style="font-size:12px;color:#888;margin-top:3px;">${a.projectName} · sin respuesta hace ${a.hoursAgo}hs</div>
    </td></tr>`).join('');

  const overdueRows = overdue.map(a =>
    `<tr><td style="padding:10px 12px;border-bottom:1px solid #f0ede8;">
      <a href="https://app.asana.com/0/${a.projectGid}/${a.taskGid}" style="color:#FF722D;font-weight:500;">${a.taskName}</a>
      <div style="font-size:12px;color:#888;margin-top:3px;">${a.projectName} · venció el ${a.dueOn} · ${a.daysOverdue}d de retraso</div>
    </td></tr>`).join('');

  const html = `
  <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#fafaf8;">
    <div style="margin-bottom:24px;">
      <span style="background:#FF722D;color:#fff;padding:4px 10px;border-radius:3px;font-size:13px;font-weight:700;">POW</span>
      <span style="font-size:12px;color:#aaa;margin-left:10px;text-transform:uppercase;letter-spacing:0.08em;">Taskpatrol</span>
    </div>
    <h2 style="font-size:18px;font-weight:400;color:#1a1a1a;margin:0 0 6px;">Hola ${name} 👋</h2>
    <p style="font-size:14px;color:#666;margin:0 0 28px;">Recordatorio diario de tareas que necesitan tu atención.</p>
    ${mentions.length > 0 ? `
    <div style="margin-bottom:24px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#aaa;margin-bottom:8px;">Menciones sin respuesta · +${ALERT_HOURS}hs</div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;border:1px solid #ede9e3;">${mentionRows}</table>
    </div>` : ''}
    ${overdue.length > 0 ? `
    <div style="margin-bottom:24px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#aaa;margin-bottom:8px;">Tareas vencidas sin update</div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;border:1px solid #ede9e3;">${overdueRows}</table>
    </div>` : ''}
    <p style="font-size:12px;color:#bbb;margin-top:32px;padding-top:16px;border-top:1px solid #ede9e3;">Taskpatrol · POW · todos los días 7am</p>
  </div>`;

  const nodemailer = await import('nodemailer');
  const t = nodemailer.default.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  await t.sendMail({
    from: `Taskpatrol POW <${GMAIL_USER}>`,
    to,
    cc: CC_EMAIL,
    subject: `[Taskpatrol] Recordatorio · ${new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}`,
    html,
  });
}

export default async function handler(req, res) {
  try {
    const cutoff = Date.now() - ALERT_HOURS * 3600 * 1000;
    const now = new Date();

    // Buscar usuarios del equipo
    const users = await asanaGet(`/workspaces/${WORKSPACE_GID}/users?opt_fields=gid,email,name&limit=100`);
    const teamEmails = TEAM.map(t => t.email);
    const teamMembers = users.filter(u => teamEmails.includes(u.email));
    console.log('[Taskpatrol] Team:', teamMembers.map(m => m.email).join(', '));

    // Buscar tareas directamente por usuario en vez de por proyecto
    let totalEmails = 0;
    for (const member of teamMembers) {
      const teamInfo = TEAM.find(t => t.email === member.email);
      const mentions = [];
      const overdue = [];

      // Traer tareas asignadas al usuario directamente
      const tasks = await asanaGet(
        `/tasks?assignee=${member.gid}&workspace=${WORKSPACE_GID}&completed_since=now&opt_fields=gid,name,due_on,modified_at,memberships.project.gid,memberships.project.name&limit=50`
      );
      console.log(`[Taskpatrol] ${member.email}: ${tasks.length} tareas`);

      for (const task of tasks) {
        const projectGid = task.memberships?.[0]?.project?.gid || WORKSPACE_GID;
        const projectName = task.memberships?.[0]?.project?.name || 'Sin proyecto';

        // Menciones sin respuesta
        const stories = await asanaGet(
          `/tasks/${task.gid}/stories?opt_fields=type,text,created_at,created_by.gid&limit=50`
        );
        const oldMentions = stories.filter(
          s => s.type === 'comment' && s.text?.includes('@') &&
               new Date(s.created_at).getTime() < cutoff
        );
        for (const mention of oldMentions) {
          const replied = stories.some(
            s => s.type === 'comment' &&
                 s.created_by?.gid === member.gid &&
                 new Date(s.created_at) > new Date(mention.created_at)
          );
          if (!replied) {
            const hoursAgo = Math.round((Date.now() - new Date(mention.created_at).getTime()) / 3600000);
            mentions.push({ taskName: task.name, taskGid: task.gid, projectName, projectGid, hoursAgo });
          }
        }

        // Tareas vencidas
        if (task.due_on) {
          const dueDate = new Date(task.due_on);
          if (dueDate < now && new Date(task.modified_at).getTime() < cutoff) {
            const daysOverdue = Math.round((now - dueDate) / 86400000);
            overdue.push({ taskName: task.name, taskGid: task.gid, projectName, projectGid, dueOn: task.due_on, daysOverdue });
          }
        }
      }

      console.log(`[Taskpatrol] ${member.email}: ${mentions.length} menciones, ${overdue.length} vencidas`);
      if (mentions.length > 0 || overdue.length > 0) {
        await sendEmail(member.email, teamInfo?.name || member.name, mentions, overdue);
        totalEmails++;
      }
    }

    return res.status(200).json({ ok: true, emailsSent: totalEmails });
  } catch (err) {
    console.error('[Taskpatrol] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
