import { handleProjectsGet, handleProjectsPost } from '@/lib/project-state/project-state-route-handler'

export const runtime = 'nodejs'
export async function GET() { return handleProjectsGet() }
export async function POST(request: Request) { return handleProjectsPost(request) }
