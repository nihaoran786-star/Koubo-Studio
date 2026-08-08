import { handleOpenChatCutGet, handleOpenChatCutPost } from '@/lib/openchatcut/route-handler'
export const runtime = 'nodejs'
export async function GET() { return handleOpenChatCutGet() }
export async function POST(request: Request) { return handleOpenChatCutPost(request) }
