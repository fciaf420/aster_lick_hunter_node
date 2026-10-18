import { NextRequest, NextResponse } from 'next/server';
import { liquidationStorage, parseLiquidationScope } from '@/lib/services/liquidationStorage';
import { ensureDbInitialized } from '@/lib/db/initDb';

export async function GET(request: NextRequest) {
  try {
    // Ensure database is initialized
    await ensureDbInitialized();

    const searchParams = request.nextUrl.searchParams;

    // ?venue=aster|lighter (default: both) and ?includeSkipped=true (default: only liquidations the bot would trade)
    const scope = parseLiquidationScope(searchParams);
    if ('error' in scope) {
      return NextResponse.json({ success: false, error: scope.error }, { status: 400 });
    }

    const params = {
      ...scope,
      symbol: searchParams.get('symbol') || undefined,
      from: searchParams.get('from') ? parseInt(searchParams.get('from')!) : undefined,
      to: searchParams.get('to') ? parseInt(searchParams.get('to')!) : undefined,
      limit: searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 100,
      offset: searchParams.get('offset') ? parseInt(searchParams.get('offset')!) : 0,
    };

    const result = await liquidationStorage.getLiquidations(params);

    return NextResponse.json({
      success: true,
      data: result.liquidations,
      pagination: {
        total: result.total,
        limit: params.limit,
        offset: params.offset,
        hasMore: params.offset! + params.limit! < result.total,
      },
    });
  } catch (error) {
    console.error('API error - get liquidations:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch liquidations',
      },
      { status: 500 }
    );
  }
}