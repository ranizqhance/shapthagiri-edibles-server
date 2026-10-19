// src/modules/catalog/categories.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { SequelizeModule } from '@nestjs/sequelize';
import { CategoriesService } from './categories.service';
import { Category } from '@/models';
import { Sequelize } from 'sequelize-typescript';

describe('CategoriesService', () => {
  let service: CategoriesService;
  let sequelize: Sequelize;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        SequelizeModule.forRoot({
          dialect: 'sqlite',
          storage: ':memory:',
          synchronize: true,
          logging: false,
          models: [Category],
        }),
        SequelizeModule.forFeature([Category]),
      ],
      providers: [CategoriesService],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
    sequelize = module.get<Sequelize>(Sequelize);
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('should create a root category with correct path', async () => {
    const cat = await service.create({ name: 'Root', slug: 'root' } as any);
    expect(cat.parentId).toBeNull();
    expect(cat.level).toBe(0);
    expect(cat.path).toBe(cat.id);
  });

  it('should create a child category with proper hierarchy', async () => {
    const root = await service.create({ name: 'Root2', slug: 'root2' } as any);
    const child = await service.create({ name: 'Child', slug: 'child', parentId: root.id } as any);
    expect(child.parentId).toBe(root.id);
    expect(child.level).toBe(1);
    expect(child.path).toBe(`${root.path}/${child.id}`);
  });

  it('should move a category and update descendants', async () => {
    const a = await service.create({ name: 'A', slug: 'a' } as any);
    const b = await service.create({ name: 'B', slug: 'b', parentId: a.id } as any);
    const c = await service.create({ name: 'C', slug: 'c', parentId: b.id } as any);
    // move B under root (null)
    await service.move(b.id, null);
    const refreshedB = await Category.findByPk(b.id);
    const refreshedC = await Category.findByPk(c.id);
    expect(refreshedB!.parentId).toBeNull();
    expect(refreshedB!.level).toBe(0);
    expect(refreshedB!.path).toBe(b.id);
    expect(refreshedC!.level).toBe(1);
    expect(refreshedC!.path).toBe(`${b.id}/${c.id}`);
  });

  it('should return descendant IDs including self', async () => {
    const p = await service.create({ name: 'P', slug: 'p' } as any);
    const q = await service.create({ name: 'Q', slug: 'q', parentId: p.id } as any);
    const ids = await service.getDescendantIds(p.id);
    expect(ids).toContain(p.id);
    expect(ids).toContain(q.id);
  });
});
