import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { DataResponseDto } from "@/common/dto/data-response.dto";

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((data) => {
        if (data && typeof data === "object" && "success" in (data as object)) return data;
        if (data && typeof data === "object" && "items" in (data as object) && "meta" in (data as object)) {
          const p = data as { items: unknown[]; meta: any };
          return DataResponseDto.ok(p, "OK", p.meta);
        }
        return DataResponseDto.ok(data ?? null);
      })
    );
  }
}
