const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus } = require('@discordjs/voice');
const { spawn } = require('child_process');
const youtubedl = require('youtube-dl-exec');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

const prefix = '!';

// Función para crear una barra de progreso
function createProgressBar(progress, total, length = 20) {
    const filled = Math.round(length * (progress / total));
    const empty = length - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `[${bar}] ${Math.round((progress / total) * 100)}%`;
}

client.on('messageCreate', async (message) => {
    if (!message.content.startsWith(prefix) || message.author.bot) return;

    const command = message.content.slice(prefix.length).trim();
    
    if (command.startsWith('play')) {
        console.log('[DEBUG] Comando play recibido');
        console.log('[DEBUG] Comando completo:', command);
        
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.reply('¡Necesitas unirte a un canal de voz primero!');
        }

        try {
            const url = command.slice(5).trim();
            console.log('[DEBUG] URL a reproducir:', url);
            
            if (!url) {
                return message.reply('¡Necesitas proporcionar una URL!');
            }

            // Iniciar proceso de conexión
            console.log('[DEBUG] Intentando conectar al canal de voz');
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
            });
            
            // Mostrar mensaje de inicialización
            const statusMessage = await message.reply('🔄 Obteniendo información del video...');

            try {
                // Obtener URL directa usando youtube-dl-exec
                console.log('[DEBUG] Obteniendo URL directa de audio');
                const output = await youtubedl(url, {
                    dumpSingleJson: true,
                    noWarnings: true,
                    noCallHome: true,
                    preferFreeFormats: true,
                    youtubeSkipDashManifest: true
                });
                
                console.log('[DEBUG] Información del video obtenida');
                
                // Intentar obtener formato de audio
                let audioUrl = null;
                if (output.formats && output.formats.length > 0) {
                    // Buscar el mejor formato de audio
                    const audioFormats = output.formats.filter(format => 
                        format.acodec !== 'none' && (format.vcodec === 'none' || format.vcodec === null)
                    );
                    
                    if (audioFormats.length > 0) {
                        // Ordenar por calidad (bitrate)
                        audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));
                        audioUrl = audioFormats[0].url;
                    } else {
                        // Si no hay formatos de solo audio, usar el primer formato con audio
                        const formatWithAudio = output.formats.find(format => format.acodec !== 'none');
                        if (formatWithAudio) {
                            audioUrl = formatWithAudio.url;
                        }
                    }
                }
                
                if (!audioUrl) {
                    audioUrl = output.url; // Usar URL principal si no se encontró formato específico
                }
                
                console.log('[DEBUG] URL de audio obtenida');
                statusMessage.edit('🔄 Preparando reproducción...');
                
                // Iniciar FFmpeg con la URL directa obtenida
                console.log('[DEBUG] Iniciando FFmpeg');
                const ffmpeg = spawn('ffmpeg', [
                    '-reconnect', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '5',
                    '-i', audioUrl,
                    '-f', 's16le',
                    '-ar', '48000',
                    '-ac', '2',
                    '-loglevel', 'warning',
                    'pipe:1'
                ]);
                
                let dataReceived = false;
                
                ffmpeg.stdout.on('data', chunk => {
                    if (!dataReceived) {
                        console.log('[DEBUG] Datos de audio recibidos');
                        dataReceived = true;
                    }
                });
                
                ffmpeg.stderr.on('data', data => {
                    console.log(`[DEBUG] FFmpeg stderr: ${data.toString()}`);
                });
                
                ffmpeg.on('close', code => {
                    console.log(`[DEBUG] FFmpeg cerrado con código: ${code}`);
                    if (code !== 0 && !dataReceived) {
                        statusMessage.edit('❌ Error al procesar el audio.');
                    }
                });
                
                // Crear reproductor y recurso
                console.log('[DEBUG] Configurando reproductor');
                const player = createAudioPlayer();
                const resource = createAudioResource(ffmpeg.stdout, {
                    inputType: StreamType.Raw,
                    inlineVolume: true
                });
                
                resource.volume.setVolume(1);
                
                // Eventos del reproductor
                player.on('stateChange', (oldState, newState) => {
                    console.log(`[DEBUG] Estado del reproductor: ${oldState.status} -> ${newState.status}`);
                });
                
                player.on(AudioPlayerStatus.Playing, () => {
                    console.log('[DEBUG] Reproducción iniciada');
                    statusMessage.edit(`▶️ Reproduciendo: ${output.title || "Audio"}`);
                });
                
                player.on(AudioPlayerStatus.Idle, () => {
                    console.log('[DEBUG] Reproducción finalizada');
                    statusMessage.edit('⏹️ Reproducción finalizada');
                    connection.destroy();
                });
                
                player.on('error', err => {
                    console.error('[DEBUG] Error en el reproductor:', err);
                    statusMessage.edit('❌ Error durante la reproducción.');
                    connection.destroy();
                });
                
                // Suscribir e iniciar reproducción
                connection.subscribe(player);
                player.play(resource);
                console.log('[DEBUG] Reproducción iniciada');
                
            } catch (innerError) {
                console.error('[DEBUG] Error al obtener o reproducir audio:', innerError);
                statusMessage.edit('❌ Error al obtener o reproducir el audio.');
                connection.destroy();
            }
            
        } catch (error) {
            console.error('[DEBUG] Error general:', error);
            message.reply('❌ Error al reproducir. Verifica la URL.');
        }
    }
});

client.once('ready', () => {
    console.log('[DEBUG] Bot listo');
});

client.login(process.env.DISCORD_TOKEN);