import { IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateRoleDto {
  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsOptional() @IsString() @MaxLength(300)
  description?: string;

  /** Initial permission keys (e.g. ["products.view","orders.view"]). */
  @IsOptional() @IsArray() @IsString({ each: true })
  permissions?: string[];
}

export class UpdateRoleDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(300)
  description?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class SetRolePermissionsDto {
  @IsArray() @IsString({ each: true })
  permissions!: string[];
}

export class DuplicateRoleDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  name?: string;
}

export class AssignRoleDto {
  /** RBAC role id to assign; null/omitted clears the RBAC role. */
  @IsOptional() @IsString()
  roleId?: string | null;
}
