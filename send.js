/* Robot de correos EN LA NUBE (GitHub Actions). Lee la cola `mails` y manda por SMTP de mail.preven.com.ar.
   Variables de entorno (secrets de GitHub): FIREBASE_SA (JSON del serviceAccount) y SMTP_PASS (clave de reservas@). */
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const nodemailer = require('nodemailer');

initializeApp({ credential: cert(JSON.parse((process.env.FIREBASE_SA || '').trim())) });
const db = getFirestore();

const transport = nodemailer.createTransport({
  host: 'mail.preven.com.ar', port: 587, secure: false, requireTLS: true,
  auth: { user: 'reservas@preven.com.ar', pass: process.env.SMTP_PASS },
  tls: { rejectUnauthorized: false },
});

const fmt = s => s ? `${s.slice(8,10)}/${s.slice(5,7)} ${s.slice(11,16)}` : '';

function compose(m, byNombre, byUser) {
  const d = m.datos || {};
  const solicitante = m.creadoPor || d.reservadoPor || '';
  const solicEmail = byNombre[solicitante] || '';
  const LAUTARO = byUser['lmusolino'] || 'lautaro.musolino@preven.com.ar';
  const AGUSTIN = byUser['agarpdahl'] || 'corporativos@preven.com.ar';
  const equipos = Array.isArray(d.equipos) ? d.equipos.join(', ') : (d.equipo || '');
  const periodo = `${fmt(d.retira)} → ${fmt(d.devuelve)}`;
  switch (m.tipo) {
    case 'reserva_nueva':
      return { to: LAUTARO, cc: AGUSTIN, replyTo: solicEmail,
        subject: `Nueva solicitud · ${equipos}`,
        html: `<p><b>${solicitante}</b> solicitó <b>${equipos}</b> para <b>${d.usuario||'-'}</b>.</p><p>Período: ${periodo}<br>Cliente: ${d.destino||'-'}<br>Estado: ${d.estado==='conf'?'confirmada':'<b>pendiente de aprobación</b>'}</p>` };
    case 'reserva_confirmada':
      return { to: solicEmail || LAUTARO, cc: [LAUTARO, AGUSTIN].join(', '), replyTo: LAUTARO,
        subject: `Reserva confirmada · ${equipos}`,
        html: `<p>Se <b>confirmó</b> la reserva de <b>${equipos}</b> para ${d.usuario||'-'}.</p><p>Período: ${periodo}<br>Cliente: ${d.destino||'-'}</p>` };
    case 'reserva_rechazada':
      return { to: solicEmail || LAUTARO, cc: [LAUTARO, AGUSTIN].join(', '), replyTo: LAUTARO,
        subject: `Solicitud rechazada · ${equipos}`,
        html: `<p>La solicitud de <b>${equipos}</b> (usuario ${d.usuario||'-'}) fue <b>rechazada</b>.</p><p>Período pedido: ${periodo}</p>` };
    case 'reserva_editada':
      return { to: LAUTARO, cc: AGUSTIN, replyTo: solicEmail,
        subject: `Reserva modificada · ${equipos}`,
        html: `<p><b>${solicitante}</b> modificó la reserva de <b>${equipos}</b> (usuario ${d.usuario||'-'}).</p><p>Período: ${periodo}<br>Cliente: ${d.destino||'-'}${d.vuelveAPendiente?'<br><b>Vuelve a quedar pendiente de aprobación.</b>':''}</p>` };
    case 'equipo_modificado': {
      const acc = d.accion==='alta' ? 'agregó' : (d.accion==='baja' ? 'eliminó' : 'modificó');
      return { to: LAUTARO, cc: AGUSTIN, replyTo: '',
        subject: `Equipo ${d.accion==='alta'?'agregado':(d.accion==='baja'?'eliminado':'modificado')} · ${d.equipo||''}`,
        html: `<p><b>${m.creadoPor||''}</b> ${acc} el equipo <b>${d.equipo||''}</b>${d.anterior&&d.anterior!==d.equipo?` (antes: ${d.anterior})`:''}.</p>` };
    }
    default: return null;
  }
}

(async () => {
  const us = (await db.collection('usuarios').get()).docs.map(d => d.data());
  const byNombre = {}, byUser = {};
  us.forEach(u => { if (u.email) { byNombre[u.nombre] = u.email; byUser[u.username] = u.email; } });

  const snap = await db.collection('mails').where('estado', '==', 'pendiente').get();
  if (snap.empty) { console.log('Sin correos pendientes.'); return; }

  for (const docu of snap.docs) {
    const m = docu.data();
    const b = compose(m, byNombre, byUser);
    if (!b) { await docu.ref.update({ estado: 'omitido' }); continue; }
    try {
      const info = await transport.sendMail({ from: 'Reservas de equipos <reservas@preven.com.ar>', to: b.to, cc: b.cc || undefined, replyTo: b.replyTo || undefined, subject: b.subject, html: b.html });
      await docu.ref.update({ estado: 'enviado', enviadoTs: Date.now() });
      console.log('✓ enviado:', m.tipo, '→', b.to, '|', info.response);
    } catch (e) {
      await docu.ref.update({ estado: 'error', error: (e.message || '').slice(0, 300) });
      console.log('✗ error:', (e.message || '').slice(0, 160));
    }
  }
})().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
