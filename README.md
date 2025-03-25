# Bot de Música para Discord

Un bot de Discord simple que reproduce música desde YouTube.

## Características

- Reproduce audio de videos de YouTube
- Comandos simples y fáciles de usar
- Mensajes de estado durante la reproducción

## Requisitos previos

- Node.js (v16.9.0 o superior)
- FFmpeg instalado en el sistema

## Instalación

1. Clona este repositorio:
   ```
   git clone https://github.com/tu-usuario/tu-repositorio.git
   cd tu-repositorio
   ```

2. Instala las dependencias:
   ```
   npm install
   ```

3. Crea un archivo `.env` con tu token de Discord:
   ```
   DISCORD_TOKEN=tu_token_va_aqui
   ```

4. Asegúrate de tener FFmpeg instalado:
   - Windows (con npm): `npm install ffmpeg`
   - Windows (manual): Descarga desde [ffmpeg.org](https://ffmpeg.org/download.html)
   - Linux (Debian/Ubuntu): `sudo apt install ffmpeg`
   - macOS (con Homebrew): `brew install ffmpeg`

## Uso

1. Inicia el bot:
   ```
   npm start
   ```

2. En Discord, usa los siguientes comandos:
   - `!play [URL de YouTube]` - Reproduce un video de YouTube

## Solución de problemas

- Si el bot no reproduce audio, verifica que FFmpeg esté instalado correctamente y esté en el PATH del sistema.
- Asegúrate de estar en un canal de voz antes de usar el comando `!play`.

## Créditos

Desarrollado por Lengo & Desstro