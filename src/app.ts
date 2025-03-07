import 'dotenv/config'
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from '@builderbot-plugins/openai-assistants'
import { typing } from './utils/presence'
import { idleFlow } from './idle-custom'

const PORT = process.env.PORT ?? 3008
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? ''

const userQueues = new Map()
const userLocks = new Map() // New lock mechanism

/**
 * Function to process the user's message by sending it to the OpenAI API
 * and sending the response back to the user.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
  await typing(ctx, provider)
  const response = await toAsk(ASSISTANT_ID, ctx.body, state)

  // Split the response into chunks and send them sequentially
  const chunks = response.split(/\n\n+/)
  for (const chunk of chunks) {
    const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, '')
    await flowDynamic([{ body: cleanedChunk }])
  }
}

/**
 * Function to handle the queue for each user.
 */
const handleQueue = async userId => {
  const queue = userQueues.get(userId)

  if (userLocks.get(userId)) return

  while (queue.length > 0) {
    userLocks.set(userId, true) // Lock the queue
    const { ctx, flowDynamic, state, provider } = queue.shift()
    try {
      await processUserMessage(ctx, { flowDynamic, state, provider })
    } catch (error) {
      console.error(`Error processing message for user ${userId}:`, error)
    } finally {
      userLocks.set(userId, false) // Release the lock
    }
  }

  userLocks.delete(userId) // Remove the lock once all messages are processed
  userQueues.delete(userId) // Remove the queue once all messages are processed
}

const mainFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME).addAction(
  async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from // Use the user's ID to create a unique queue for each user

    if (!userQueues.has(userId)) {
      userQueues.set(userId, [])
    }

    const queue = userQueues.get(userId)
    queue.push({ ctx, flowDynamic, state, provider })

    // If this is the only message in the queue, process it immediately
    if (!userLocks.get(userId) && queue.length === 1) {
      await handleQueue(userId)
    }
  }
)

const mediaFlow = addKeyword(EVENTS.MEDIA).addAnswer(
  'Si la imagen que acabas de enviar corresponde a un comprobante de pago, por favor, adjuntalo la imagen del comprobante en el siguiente formulario: https://forms.gle/AqY1iVC7XgUrK6y28'
)

const voiceNoteFlow = addKeyword(EVENTS.VOICE_NOTE).addAnswer(
  'No puedo reproducir el contenido del audio en este momento, ¿podrías escribir tu consulta?'
)

const main = async () => {
  const adapterFlow = createFlow([mainFlow, mediaFlow, voiceNoteFlow, idleFlow])

  const adapterProvider = createProvider(BaileysProvider, {
    groupsIgnore: true
  })

  const adapterDB = new MemoryDB()

  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB
  })

  httpInject(adapterProvider.server)
  httpServer(+PORT)
}

main()
