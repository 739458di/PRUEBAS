// FYRADRIVE - Privacy Policy Page
// GET /api/privacy = shows privacy policy

module.exports = async function handler(req, res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Política de Privacidad - FYRADRIVE</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; color: #333; line-height: 1.6; }
        h1 { color: #1a1a2e; border-bottom: 3px solid #e94560; padding-bottom: 10px; }
        h2 { color: #1a1a2e; margin-top: 30px; }
        .logo { font-size: 24px; font-weight: bold; color: #e94560; margin-bottom: 20px; }
        .updated { color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="logo">FYRADRIVE</div>
    <h1>Política de Privacidad</h1>
    <p class="updated">Última actualización: 12 de febrero de 2025</p>

    <h2>1. Información que recopilamos</h2>
    <p>FYRADRIVE recopila la siguiente información cuando interactúas con nosotros a través de Facebook Messenger o WhatsApp:</p>
    <ul>
        <li>Nombre de perfil público de Facebook/WhatsApp</li>
        <li>Mensajes que nos envías directamente</li>
        <li>Información sobre vehículos de tu interés (modelo, precio, tipo de financiamiento)</li>
    </ul>

    <h2>2. Cómo usamos tu información</h2>
    <p>Utilizamos tu información exclusivamente para:</p>
    <ul>
        <li>Responder tus consultas sobre vehículos</li>
        <li>Generar cotizaciones personalizadas</li>
        <li>Mejorar nuestro servicio de atención al cliente</li>
    </ul>

    <h2>3. Compartición de datos</h2>
    <p>NO vendemos, alquilamos ni compartimos tu información personal con terceros. Tu información se usa únicamente para brindarte servicio dentro de FYRADRIVE.</p>

    <h2>4. Almacenamiento y seguridad</h2>
    <p>Tus datos se almacenan de forma segura en servidores protegidos. Implementamos medidas de seguridad técnicas y organizativas para proteger tu información personal.</p>

    <h2>5. Retención de datos</h2>
    <p>Conservamos tus datos mientras sea necesario para proporcionarte nuestros servicios. Puedes solicitar la eliminación de tus datos en cualquier momento.</p>

    <h2>6. Eliminación de datos</h2>
    <p>Puedes solicitar la eliminación de todos tus datos personales enviando un mensaje a nuestro Facebook Messenger o contactándonos directamente. También puedes usar nuestra <a href="/api/data-deletion">página de eliminación de datos</a>.</p>

    <h2>7. Tus derechos</h2>
    <p>Tienes derecho a:</p>
    <ul>
        <li>Acceder a tus datos personales</li>
        <li>Solicitar la corrección de datos inexactos</li>
        <li>Solicitar la eliminación de tus datos</li>
        <li>Retirar tu consentimiento en cualquier momento</li>
    </ul>

    <h2>8. Contacto</h2>
    <p>Para cualquier consulta sobre privacidad, contáctanos a través de nuestra página de Facebook: <strong>FYRADRIVE</strong></p>

    <h2>9. Cambios a esta política</h2>
    <p>Nos reservamos el derecho de actualizar esta política. Cualquier cambio será publicado en esta página con la fecha de actualización correspondiente.</p>
</body>
</html>`);
};
