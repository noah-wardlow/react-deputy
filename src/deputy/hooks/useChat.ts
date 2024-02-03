import { useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { FunctionCallHandler, Message, AiFunction, FunctionCall } from '../assistant/types'
import { fetchAndDecodeChatCompletion } from '../utils/fetchChatCompletion'
import { DeputyApiConfig } from '../utils/standard-api-config'
// import { CopilotApiConfig } from "../context";

export type UseChatOptions = {
  /**
   * The API endpoint that accepts a `{ messages: Message[] }` object and returns
   * a stream of tokens of the AI chat response. Defaults to `/api/chat`.
   */
  api?: string
  /**
   * A unique identifier for the chat. If not provided, a random one will be
   * generated. When provided, the `useChat` hook with the same `id` will
   * have shared states across components.
   */
  id?: string
  /**
   * System messages of the chat. Defaults to an empty array.
   */
  initialMessages?: Message[]
  /**
   * Callback function to be called when a function call is received.
   * If the function returns a `ChatRequest` object, the request will be sent
   * automatically to the API and will be used to update the chat.
   */
  onFunctionCall?: FunctionCallHandler
  /**
   * HTTP headers to be sent with the API request.
   */
  headers?: Record<string, string> | Headers
  /**
   * Extra body object to be sent with the API request.
   * @example
   * Send a `sessionId` to the API along with the messages.
   * ```js
   * useChat({
   *   body: {
   *     sessionId: '123',
   *   }
   * })
   * ```
   */
  body?: object
  /**
   * Function definitions to be sent to the API.
   */
  functions?: AiFunction[]
}

export type UseChatHelpers = {
  /** Current messages in the chat */
  messages: Message[]
  /**
   * Append a user message to the chat list. This triggers the API call to fetch
   * the assistant's response.
   * @param message The message to append
   */
  append: (message: Message) => Promise<void>
  /**
   * Reload the last AI chat response for the given chat history. If the last
   * message isn't from the assistant, it will request the API to generate a
   * new response.
   */
  reload: () => Promise<void>
  /**
   * Abort the current request immediately, keep the generated tokens if any.
   */
  stop: () => void

  /** Whether the API request is in progress */
  isLoading: boolean
}

export type UseChatOptionsWithCopilotConfig = UseChatOptions & {
  deputyConfig: DeputyApiConfig
}

export function useChat(options: UseChatOptionsWithCopilotConfig): UseChatHelpers {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const abortControllerRef = useRef<AbortController>()

  const runChatCompletion = async (messages: Message[]): Promise<Message | undefined> => {
    setIsLoading(true)
    const assistantMessage: Message = {
      id: nanoid(),
      createdAt: new Date(),
      content: '',
      role: 'assistant',
    }
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    setMessages([...messages, { ...assistantMessage }])

    const messagesWithContext = [...(options.initialMessages || []), ...messages]
    const response = await fetchAndDecodeChatCompletion({
      deputyConfig: options.deputyConfig,
      messages: messagesWithContext,
      functions: options.functions,
      headers: options.headers,
      signal: abortController.signal,
    })

    if (!response.events) {
      throw new Error('Failed to fetch chat completion')
    }

    const reader = response.events.getReader()

    let done = false

    while (!done) {
      try {
        const { done: doneStreaming, value } = await reader.read()

        if (doneStreaming) {
          setIsLoading(false)
          done = true
          return { ...assistantMessage }
        }

        if (value.type === 'content') {
          assistantMessage.content += value.content
          setMessages([...messages, { ...assistantMessage }])
        } else if (value.type === 'function') {
          assistantMessage.function_call = {
            name: value.name,
            arguments: JSON.stringify(value.arguments),
          }
          setMessages([...messages, { ...assistantMessage }])
          // quit early if we get a function call
          setIsLoading(false)
          return { ...assistantMessage }
        }
      } catch (error) {
        setIsLoading(false)
        throw error
      }
    }
  }

  const runChatCompletionAndHandleFunctionCall = async (messages: Message[]): Promise<void> => {
    const message = await runChatCompletion(messages)
    if (message?.function_call && options.onFunctionCall) {
      await options.onFunctionCall(messages, message.function_call as FunctionCall)
    }
  }

  const append = async (message: Message): Promise<void> => {
    if (isLoading) {
      return
    }
    const newMessages = [...messages, message]
    setMessages(newMessages)
    return runChatCompletionAndHandleFunctionCall(newMessages)
  }

  const reload = async (): Promise<void> => {
    if (isLoading || messages.length === 0) {
      return
    }
    let newMessages = [...messages]
    const lastMessage = messages[messages.length - 1]

    if (lastMessage.role === 'assistant') {
      newMessages = newMessages.slice(0, -1)
    }
    setMessages(newMessages)

    return runChatCompletionAndHandleFunctionCall(newMessages)
  }

  const stop = (): void => {
    abortControllerRef.current?.abort()
  }

  return {
    messages,
    append,
    reload,
    stop,
    isLoading,
  }
}
