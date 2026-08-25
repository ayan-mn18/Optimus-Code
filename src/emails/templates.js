const COLORS = {
  canvas: '#08080b',
  card: '#131318',
  elevated: '#1a1a22',
  line: '#2b2b38',
  ink: '#f2f2f7',
  muted: '#a1a1b0',
  dim: '#6e6e80',
  brand: '#8b7bff',
  brandPale: '#c4b5fd',
  accent: '#22d3ee',
  good: '#34d399',
  bad: '#f4696b',
  warn: '#fab219',
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const firstName = (name) => escapeHtml(name?.trim().split(/\s+/)[0] || 'there');

function layout({ preheader, eyebrow, title, intro, content, cta, footnote }) {
  const action = cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 12px"><tr><td style="border-radius:12px;background:#7c5cff"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:14px 24px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px">${escapeHtml(cta.label)}</a></td></tr></table>`
    : '';

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:${COLORS.canvas};color:${COLORS.ink};font-family:Inter,Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.canvas}">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;border:1px solid ${COLORS.line};border-radius:20px;background:${COLORS.card};overflow:hidden">
        <tr><td style="height:6px;background:linear-gradient(90deg,#7c5cff,#8b7bff,#22d3ee)"></td></tr>
        <tr><td style="padding:28px 32px 12px">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
            <td style="width:34px;height:34px;border-radius:12px;background:#7c5cff;color:white;text-align:center;font-weight:800">O</td>
            <td style="padding-left:12px;color:${COLORS.ink};font-size:16px;font-weight:700">Optimus Code</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:24px 32px 34px">
          <p style="margin:0 0 10px;color:${COLORS.brandPale};font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase">${escapeHtml(eyebrow)}</p>
          <h1 style="margin:0;color:${COLORS.ink};font-size:32px;line-height:1.15;letter-spacing:-0.6px">${escapeHtml(title)}</h1>
          <p style="margin:16px 0 0;color:${COLORS.muted};font-size:16px;line-height:1.65">${intro}</p>
          ${content}
          ${action}
          ${footnote ? `<p style="margin:18px 0 0;color:${COLORS.dim};font-size:12px;line-height:1.6">${footnote}</p>` : ''}
        </td></tr>
      </table>
      <p style="margin:18px 0 0;color:${COLORS.dim};font-size:11px">Optimus Code · Daily DSA, without decision fatigue.</p>
    </td></tr>
  </table>
</body>
</html>`;
}

const stat = (label, value, color = COLORS.ink) => `
<td width="33%" style="padding:14px 10px;border:1px solid ${COLORS.line};background:${COLORS.elevated};text-align:center">
  <div style="color:${color};font-size:24px;font-weight:800">${escapeHtml(value)}</div>
  <div style="margin-top:4px;color:${COLORS.dim};font-size:11px;text-transform:uppercase;letter-spacing:1px">${escapeHtml(label)}</div>
</td>`;

export function inviteEmail({ name, inviteUrl, expiresHours }) {
  const greeting = firstName(name);
  return {
    subject: 'Your Optimus Code invite is ready',
    html: layout({
      preheader: 'Create your private Optimus Code account.',
      eyebrow: 'Private invite',
      title: 'Your daily practice starts here.',
      intro: `Hi ${greeting}. Your waitlist invite is ready. Choose your own password, set your daily target, and let Optimus Code build the queue.`,
      content: `<div style="margin-top:24px;padding:18px;border:1px solid ${COLORS.line};border-radius:14px;background:${COLORS.elevated}">
        <p style="margin:0;color:${COLORS.ink};font-size:14px;font-weight:700">One secure link</p>
        <p style="margin:7px 0 0;color:${COLORS.muted};font-size:13px;line-height:1.6">This invite works once and expires after ${escapeHtml(expiresHours)} hours. Nobody receives your password by email.</p>
      </div>`,
      cta: { label: 'Create my account', url: inviteUrl },
      footnote: 'If you did not join the Optimus Code waitlist, ignore this email. The link will expire automatically.',
    }),
    text: `Hi ${name?.trim().split(/\s+/)[0] || 'there'},\n\nYour Optimus Code invite is ready. Create your account here:\n${inviteUrl}\n\nThis one-time link expires after ${expiresHours} hours. If you did not request it, ignore this email.`,
  };
}

export function accountReadyEmail({ name, loginUrl }) {
  return {
    subject: 'Your Optimus Code account is ready',
    html: layout({
      preheader: 'Sign in and choose your daily target.',
      eyebrow: 'Account ready',
      title: `Welcome, ${name?.trim().split(/\s+/)[0] || 'solver'}.`,
      intro: 'Your account is live. Sign in with the email and password you just chose, then pick a daily target that stays realistic.',
      content: `<table role="presentation" width="100%" cellspacing="8" cellpadding="0" border="0" style="margin-top:22px"><tr>
        ${stat('Start small', '3/day', COLORS.good)}${stat('Build rhythm', '5/day', COLORS.brandPale)}${stat('Push hard', '8/day', COLORS.accent)}
      </tr></table>`,
      cta: { label: 'Sign in to Optimus Code', url: loginUrl },
      footnote: 'Optimus Code will never email your password. Keep it private.',
    }),
    text: `Welcome, ${name}. Your Optimus Code account is ready. Sign in here: ${loginUrl}\n\nUse the email and password you chose during account creation.`,
  };
}

export function milestoneEmail({ name, milestone, headline, topTopics, nextMilestone, appUrl }) {
  const topics = topTopics.slice(0, 3)
    .map((topic, index) => `<tr><td style="padding:8px 0;color:${COLORS.muted};font-size:14px">${index + 1}. ${escapeHtml(topic.topic)}</td><td align="right" style="color:${COLORS.ink};font-weight:700">${escapeHtml(topic.count)}</td></tr>`)
    .join('');

  return {
    subject: `${milestone} solved. That is a real milestone.`,
    html: layout({
      preheader: `${milestone} problems solved on Optimus Code.`,
      eyebrow: 'Milestone unlocked',
      title: `${milestone} problems solved.`,
      intro: `${firstName(name)}, ${escapeHtml(headline)}`,
      content: `<div style="margin-top:24px;text-align:center"><div style="font-size:76px;font-weight:850;line-height:1;background:linear-gradient(90deg,#c4b5fd,#8b7bff,#22d3ee);color:${COLORS.brandPale}">${escapeHtml(milestone)}</div><div style="margin-top:8px;color:${COLORS.dim};font-size:12px;letter-spacing:2px;text-transform:uppercase">Problems complete</div></div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px;border-top:1px solid ${COLORS.line};border-bottom:1px solid ${COLORS.line}">${topics}</table>`,
      cta: { label: 'Open my milestone recap', url: `${appUrl}/dashboard` },
      footnote: `Next marker: ${nextMilestone}. Keep the pace sustainable.`,
    }),
    text: `${name}, you solved ${milestone} problems. ${headline}\n\nNext milestone: ${nextMilestone}. View your recap: ${appUrl}/dashboard`,
  };
}

export function redDayEmail({ name, date, solved, required, loginUrl }) {
  return {
    subject: 'Yesterday closed red. Today stays open.',
    html: layout({
      preheader: 'Your missed problems returned to the practice mix.',
      eyebrow: 'Daily recap',
      title: 'One red day changes nothing.',
      intro: `Hi ${firstName(name)}. ${escapeHtml(date)} closed at ${escapeHtml(solved)} of ${escapeHtml(required)}. The unfinished problems returned to your mix, ready for another attempt.`,
      content: `<div style="margin-top:24px;padding:18px;border-left:3px solid ${COLORS.bad};border-radius:10px;background:${COLORS.elevated}"><p style="margin:0;color:${COLORS.ink};font-size:15px;font-weight:700">No reset. No guilt.</p><p style="margin:7px 0 0;color:${COLORS.muted};font-size:13px;line-height:1.6">Open today’s set and rebuild momentum with the first problem.</p></div>`,
      cta: { label: 'Start today’s set', url: loginUrl },
      footnote: 'You receive this only when a challenge day closes below target.',
    }),
    text: `Hi ${name}. ${date} closed red at ${solved}/${required}. Your unfinished problems returned to the mix. Start today: ${loginUrl}`,
  };
}

export function streakRiskEmail({ name, remaining, currentStreak, hoursLeft, loginUrl }) {
  const streakCopy = currentStreak > 0 ? `${currentStreak}-day streak` : 'daily target';
  return {
    subject: `${remaining} left today. Your ${streakCopy} is waiting.`,
    html: layout({
      preheader: `${remaining} problems remain before local midnight.`,
      eyebrow: 'Streak check',
      title: `${plural(remaining, 'problem')} left today.`,
      intro: `Hi ${firstName(name)}. About ${escapeHtml(hoursLeft)} hours remain before local midnight. A short focused block can still close the day green.`,
      content: `<table role="presentation" width="100%" cellspacing="8" cellpadding="0" border="0" style="margin-top:22px"><tr>
        ${stat('Remaining', remaining, COLORS.warn)}${stat('Current streak', `${currentStreak}d`, COLORS.brandPale)}${stat('Hours left', hoursLeft, COLORS.accent)}
      </tr></table>`,
      cta: { label: 'Finish today’s set', url: loginUrl },
      footnote: 'This reminder sends once, near the end of your local day.',
    }),
    text: `Hi ${name}. ${remaining} problems remain, with about ${hoursLeft} hours before local midnight. Continue here: ${loginUrl}`,
  };
}

function plural(count, word) {
  return `${count} ${word}${Number(count) === 1 ? '' : 's'}`;
}
