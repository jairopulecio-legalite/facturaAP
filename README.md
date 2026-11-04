# Facturación AP · Grupo Legalite

Aplicación interna basada en el formato **L-AP-F-02 · Hoja de facturación** suministrado por el equipo. Conserva la importación y validación de Excel, tabla de confirmaciones, filtros, exportación Excel/PDF y trazabilidad. Esta versión añade autenticación y persistencia compartida para desplegar con **Dokploy y Docker Compose**.

## Protección de datos

El HTML original tenía información real de clientes y datos de trazabilidad incrustados. **El repositorio NO debe contener esa información**. La versión distribuida inicia vacía. Carga el archivo mensual desde la interfaz una vez que inicies sesión. **IMPORTANTE:** el repositorio actual `jairopulecio-legalite/facturaAP` está público. Se recomienda cambiarlo a **privado** desde GitHub → Settings → General → Danger Zone → Change repository visibility. No se incluyeron datos reales de clientes ni contraseñas.

## Usuarios y funciones

- **admin:** puede cargar/reemplazar el Excel del mes (esta acción reinicia las confirmaciones) y registrar estados y exportar.
- **operador:** puede consultar, confirmar, descargar Excel/PDF y ver trazabilidad. No puede reemplazar el Excel del mes.
- Confirmaciones y eventos se guardan en el servidor, y cada navegador se actualiza automáticamente cada 4 segundos.
- Los usuarios se configuran en `USERS_JSON` del despliegue; cada persona debe tener credenciales propias.
- Los datos sobreviven a reinicios y nuevas versiones gracias al volumen Docker `facturacion_ap_data`.

## Desplegar desde GitHub en Dokploy

1. Utiliza el repositorio `https://github.com/jairopulecio-legalite/facturaAP`, rama `main`. Configura su visibilidad como **privada**.
2. En Dokploy, crea un proyecto y un servicio **Docker Compose**, conectado al repositorio y a la rama `main`.
3. En la ruta del compose, selecciona `docker-compose.yml` (en la raíz).
4. Define variables de entorno en Dokploy:
   - `SESSION_SECRET`: al menos 32 caracteres, generado con `openssl rand -hex 32`.
   - `USERS_JSON`: un arreglo JSON con un objeto por persona, p. ej. `[ {"username":"gerencia","password":"UnaContrasenaLargaUnica123!","role":"admin"}, {"username":"auxiliar1","password":"OtraContrasenaUnicaSegura123!","role":"operador"} ]` (reemplaza las contraseñas del ejemplo).
5. Despliega el stack. Añade un dominio al servicio `facturacion-ap`, destino interno `3000`, con HTTPS habilitado por Dokploy.
6. Accede con las cuentas configuradas, carga el Excel del periodo y confirma que otro usuario vea la misma tabla.

**Importante**: no publiques el servicio directamente mediante `ports:`, no subas `.env` ni hojas Excel al repositorio, y no elimines los volúmenes de Dokploy al actualizar. Programa copias de seguridad del volumen (incluye `state.json` y `ultimo.xlsx`). Si restauras una copia, detén el contenedor antes de reemplazar archivos.

## Ejecución local (sin Docker)

Con Node.js 22 o superior:

```bash
cp .env.example .env
# Sustituye secretos y contraseñas por valores reales en .env
set -a; . ./.env; set +a
node server.js
```

Abre `http://localhost:3000`. Los datos quedan en `./data/`, excluidos de Git. `docker compose up -d --build` sirve para hacer la misma prueba con Docker y un volumen persistente.

## Alcance y limitaciones

- Persistencia JSON atómica en disco, adecuada para un pequeño equipo en una sola instancia del contenedor. **No escalar a varias réplicas** con esta implementación. Para una operación de mayor concurrencia, migrar a PostgreSQL.
- La descarga del último Excel conserva la versión saneada que se cargó. La vista de hoja completa solo está disponible en el navegador que conserva esa copia en IndexedDB. Cualquier usuario puede descargar el último Excel compartido desde el logotipo (doble clic).
- Se utiliza HTTPS terminado en el proxy de Dokploy; es obligatorio para producción. No hay recuperación automática de contraseñas: el administrador del despliegue las gestiona en variables de entorno.
- El sistema no emite facturas electrónicas ni se conecta con DIAN; organiza y confirma la hoja mensual de AP.
- Librerías de Excel/PDF y fuentes se cargan desde CDN externos; para operaciones sin internet requieren empaquetarse localmente.
- El archivo original incluía lógica específica para un entorno `window.claude` que no funciona fuera de ese entorno. Fue sustituida por API propia en modo web.