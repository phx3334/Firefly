---
title: python的核心特性
published: 2026-08-06T15:00:21+08:00
description: '更加全面了解python的设计'
image: './images/a11.avif'
tags: [编程语言,python]
category: '计算机技术'
draft: false
lang: '中文'
---
## 迭代器
### 定义
- 可迭代对象（iterable）：有 `__iter__` 方法的对象（list/str/dict/tuple...）
- 迭代器（iterator）：有 `__next__`和 `__iter__` 方法的对象，可以记住下一个是谁
- 关系：iterable 经 iter() 返回 iterator；iterator 同时有 `__iter__` 和 `__next__`
### 源码简化部分
```python
class List
    def __iter__(self):
        return ListIterator(self)
```
```python
class ListIterator:
    def __iter__(self):
        return self
    def __init__(self,tar):
        self.tar=tar
        self.Index=0
    def __next__(self):
        if self.Index >= len(self.tar):
            raise StopIteration
        result=self.tar[self.Index]
        self.Index+=1
        return result
```
### `for x in obj`的内部过程
```python
# for x in tar:
#     print(x)
#
# 解释器真正做的事（Python 伪代码等价）：
_it=List.iter(tar)
_it = ListIterator(tar) 

while true:
    try:
        x=_it.next()
    except StopIteration:
        break
    print(x)
```
### 生成器
#### 介绍
- 生成器函数（含 yield）调用后返回生成器对象，自动拥有 __iter__/__next__
- 不用手写 __iter__/__next__/StopIteration/状态变量，全帮你省了
#### yield 是什么：暂停 + 记住现场
- 遇到 yield 就"产出值并暂停"，下次 next() 从暂停处继续
- 对比 return：return 直接结束；yield 是"交出一个值但函数还活着"
```python
def count(n):
    while n>0:
        yield n
        n-=1
c=count(3)
print(isinstance(c,Iterator))#true
print(next(c))#3
print(next(c))#2
print(next(c))#1
```
### 生成器（迭代器）的价值
- 惰性计算，省内存
``` python
# 急切：先算出 1000 万个平方，全部塞进内存
squares_list = [x*x for x in range(10_000_000)]   # 内存立刻暴涨

# 惰性：只在你取的时候才算，内存几乎恒定
squares_gen = (x*x for x in range(10_000_000))    # 几乎不占内存
print(next(squares_gen))      # 0，随取随算
```
- 流式处理大文件 / 大数据
``` python
def read_big_file(path):
    with open(path,encoding="utf-8") as f:
        for line in f:
            yield line.strip()
for line in read_big_file("./data/test.txt"):
    print(line)
```
- 把"生产数据"和"消费数据"解耦
```python
def producer():
    for i in range(5):
        yield f"task{i}"
def consumer():
    for task in producer():
        print(f"正在执行 {task}")

consumer()
```
- 可无限序列，列表做不到
```python
def fib():
    a, b = 0, 1
    while True:
        yield a
        a, b = b, a + b

g = fib()
for _ in range(10):
    print(next(g))    #可以无限计算，这里用10举例
```
### 补充
`for ... range..`中range本质也是一个迭代器对象  
如果同时需要索引和值可以用`enumerate`  
选择迭代器的方式进行遍历，可以统一遍历所有类型的容器，不再局限于只能由整数下标访问。


## 装饰器
### 引子
- 本质：一个把"旧函数"包一层、返回"新函数"的可调用对象
- 语法糖 @ 只是 wrapper = deco(wrapper) 的简写
- 核心目的：在不改原函数代码的前提下，附加日志/计时/鉴权/缓存等行为
### 原理以及使用
```python
def log(func):
    def wrapper(*args, **kwargs):
        print(f"[调用] 函数 {func.__name__}，参数 args={args}, kwargs={kwargs}")
        result = func(*args, **kwargs)
        print(f"[返回] 函数 {func.__name__}，结果={result}")
        return result
    return wrapper

@log
def add(a, b):
    return a + b
add(3, 5)
#或者
#add = log(add)
#add(3, 5)

# 输出：
# [调用] 函数 add，参数 args=(3, 5), kwargs={}
# [返回] 函数 add，结果=8
```
### 添加functools（python官方写好的函数处理工具）
```python
import functools

def log(func):
    @functools.wraps(func)          # 保留原函数的 __name__ / __doc__等元信息
    def wrapper(*args, **kwargs):
        print(f"[调用] {func.__name__} 参数={args}, {kwargs}")
        result = func(*args, **kwargs)
        print(f"[返回] {func.__name__} 结果={result}")
        return result
    return wrapper

@log
def add(a, b):
    """两数相加"""
    return a + b

print(add.__name__)     # add（不加 wraps 会变成 wrapper）
print(add.__doc__)      # 两数相加（元信息被保留）
```


## 抽象基类
### 定义
抽象基类（Abstract Base Class，简称 ABC） 就是：只定义"该有哪些方法/属性"、但不（或不全）实现，专门用来当"规范/模板"让别的类去继承并补全的类。  
### 使用
```python
from abc import ABC, abstractmethod
class Animal(ABC):              # 继承 ABC，成为抽象基类
    @abstractmethod
    def speak(self):            # 只声明，不实现（或抛 NotImplementedError）
        pass

    @abstractmethod
    def eat(self):
        pass

class Dog(Animal):
    def speak(self):          
        return "汪汪"
    def eat(self):
        return "吃狗粮"

d = Dog()                       # 实现了全部抽象方法，才能实例化
print(d.speak())                # 汪汪
```


## 元类
### 类也是对象
- type 既是查看类型的函数，也是所有类的默认元类
- 类在定义时由元类实例化生成，类本身是个对象
### 查找链
- 实例的查找遵循MRO， 一个实例去哪找属性/方法 → 顺着"实例 → 类 → 父类"往上找。（终点是object这个母类）   
- 一个对象的"类型是谁" 顺着"实例 → 类 → 元类(type)"往上找。  
`补充`每个对象都有一个__class__属性，指向"造出我的类"  
### 自定义元类
一般来说，自定义元类只需要重写`__init__`和`__new__`方法；  
当你创建类时`class Foo(metaclass=Meta)`,type.__call__(因为meta没有重写__call__)内部去调用 `Meta.__new__` 和 `Meta.__init__` 来产出类对象。  
当你创建`Foo`的实例是，走的是 type.__call__(因为meta没有重写__call__)，它内部再调 Foo.__new__ + Foo.__init__  
```python
import re

class CamelCaseMeta(type):
    # 所有用本元类创建的类，都会被登记到这里
    registry = {}

    # 驼峰命名正则：首字母大写，仅含字母数字
    _pattern = re.compile(r"^[A-Z][A-Za-z0-9]*$")

    # __new__：控制"类"怎么被造（类创建阶段，校验 + 改 ns）
    def __new__(mcs, name, bases, ns):#（元类本身，正在被创建的类名，父类元组即"继承谁"，类体执行出来的命名空间字典，装着类里所有属性/方法的引用）
        if not CamelCaseMeta._pattern.match(name):
            raise TypeError(f"类名 '{name}' 必须符合驼峰命名法（如 MyClass）")
        # 还可以改 ns，给类统一加个类属性（示例）
        ns["author"] = "victor"
        cls = super().__new__(mcs, name, bases, ns)   # 真正产出类对象
        return cls

    # __init__：类造好之后做初始化（类创建阶段收尾）
    def __init__(cls, name, bases, ns):#cls是类对象本身
        # 自动注册：把类登记进 registry，供插件发现/工厂使用
        CamelCaseMeta.registry[name] = cls
        # 没写 VERSION 就补默认值
        if not hasattr(cls, "VERSION"):
            cls.VERSION = "1.0"
        super().__init__(name, bases, ns)             # 标准收尾，必须保留

    # __call__：控制"类名() 怎么造实例"（实例创建阶段）
    def __call__(cls, *args, **kwargs):
        print(f"准备创建 '{cls.__name__}' 的实例，参数={args}, {kwargs}")
        instance = super().__call__(*args, **kwargs)  # 内部调 cls.__new__ + cls.__init__
        # 实例造好后，额外加工（示例：打创建标记）
        instance._created_by_meta = True
        print(f"实例创建完成：{instance}")
        return instance


# ===== 用法示例 =====
class UserService(metaclass=CamelCaseMeta):
    def __init__(self, uid):
        self.uid = uid

print("\n===== 实例化阶段（触发元类 __call__）=====")
u = UserService(1001)
print("u.uid =", u.uid)
print("u._created_by_meta =", u._created_by_meta)
print("u.author =", u.author)     
print("u.VERSION =", u.VERSION)            

print("\n===== 注册表 =====")
print(CamelCaseMeta.registry)              

```


## 深浅拷贝
- **赋值不是拷贝**：`b = a` 只是多一个名字绑到同一对象，改一个另一个跟着变。
- **浅拷贝 `copy.copy`**：只复制最外层对象，内层嵌套对象仍**共用原引用**。
```python
import copy
a = [1, 2, [3, 4]]
c = copy.copy(a)        # 或 a.copy() / list(a) / a[:]
c[0] = 999             # 改最外层：a 不受影响
c[2][0] = 888          # 改嵌套层：a 跟着变（内层列表是同一份）
```
- **深拷贝 `copy.deepcopy`**：递归复制所有层级，原对象与副本**完全独立**。
```python
d = copy.deepcopy(a)
d[2][0] = 888          # a 完全不受影响
```
- 对比：`b=a`（同一对象）→ `copy.copy`（外层新建、内层共用）→ `copy.deepcopy`（全部新建）。
- 注意：差异只在**嵌套的可变对象**（list/dict/自定义对象）上显现；不可变对象（int/str/tuple 等）改不了，深浅看起来一样。自定义对象可定义 `__copy__`/`__deepcopy__` 自定义行为。



## 错误处理
- **基本结构**：`try` 跑可能出错的代码；`except` 捕获并处理；`else` 在无异常时执行；`finally` 无论是否异常都执行（常用于释放资源）。
```python
try:
    x = 1 / 0
except ZeroDivisionError as e:   # e 是异常对象
    print("出错了:", e)
else:
    print("没出错才执行")
finally:
    print("无论是否异常都执行")
```
- **捕获多个**：`except (ValueError, TypeError) as e:` 
- **主动抛 & 自定义**：`raise ValueError("非法")` 主动抛出；自定义异常继承 `Exception`：`class MyError(Exception): pass`。
- 注意点：
  - 别裸 `except:`（会吞掉 Ctrl+C 等系统信号），应捕获具体异常或 `Exception`；
  - 所有异常继承自 `BaseException`，业务异常继承 `Exception`，不要直接继承 `BaseException`：`BaseException` 下除 `Exception` 外，还直接挂着系统级信号；继承它会被 `except BaseException:`（或裸 `except:`）一并捕获，导致 Ctrl+C 关不掉程序。业务异常继承 `Exception` 即可。
  - 异常链：用 `raise NewError() from e` 保留原始异常`e`，而不是只是反映表层原因。`raise` 单独用可将错误信息往上层抛，让具有足够信息的上层处理。



## 包管理
- **模块与包**：单个 `.py` 文件是模块；含 `__init__.py` 的目录是包，可多层嵌套。
- 模块自身 `__name__`：直接运行 `python foo.py` 时 `__name__ == "__main__"`；被 `import` 时为模块名（如 `"foo"`）。入口守卫写法：`if __name__ == "__main__": main()`。
```python
# foo.py
def main():
    print("程序入口逻辑")

print("模块被加载时就会执行（无论 import 还是直接运行）")

if __name__ == "__main__":
    main()          # 只有直接运行 python foo.py 才执行

# 直接运行：python foo.py
#   输出两行：模块被加载时就会执行... / 程序入口逻辑
# 被导入：import foo
#   只输出一行：模块被加载时就会执行...（main 不会自动跑）
```
- 包内 `__name__` 是点分全名：`mypkg/__init__.py` 为 `"mypkg"`，`mypkg/sub/mod.py` 为 `"mypkg.sub.mod"`，不是相对路径。
- `__init__.py` 的 `__name__` 即包名：导入包时执行，可在此做初始化、用 `__all__` 暴露公共 API。（仅限制from ... import *不限制import 包）
- 不要手动改 `__name__`：它是解释器管理的只读标识。
- **包导入与名称空间的联系**：`import` 本质是在当前全局名称空间里建一个"名字 → 模块对象"的绑定；模块对象内部用自身的 `__dict__`（模块级名称空间）装着它所有的全局变量/函数/类。
- **`from import` 的覆盖问题**：`from A import x` 是把 `A.x` **按名字**直接绑进当前全局名称空间。如果当前作用域里已经有个同名变量，就会被静默覆盖；而且覆盖是「按导入语句执行的顺序」发生的，不易察觉。
```python
from math import sqrt      # 全局名称空间里有了 sqrt → math.sqrt
sqrt = "hello"             # 自己的变量，同名
from cmath import sqrt     # 又来一个 sqrt，把上面的字符串覆盖成 cmath.sqrt

print(sqrt(4))             # 此时 sqrt 是 cmath.sqrt，字符串 "hello" 已被悄悄盖掉
```
  - 对比 `import A`：它只在全局名称空间绑一个 `A` 名字，访问走 `A.x`，**不会**和你的局部变量撞名，更安全。
  - 同名跨模块：从不同模块 `from a import f` 和 `from b import f`，后执行的会覆盖先执行的 `f`，且不会报错，调试时极难发现。
  - 规避办法：①用 `import A` + `A.x` 的写法避免名字冲突；②用 `from A import x as y` 主动改名；③通配 `from A import *` 最危险，会一次性把 A 的一堆名字灌进当前空间，极易覆盖面已有的名字，能不用就不用。
  - 与名称空间衔接：覆盖发生在「绑进当前全局名称空间」这一步（见「包导入与名称空间的联系」），`from import` 越过了「模块对象」这层隔离，直接把属性名字写进调用方空间，所以才会出现同名覆盖。

### FAQ
#### 为什么裸路径运行会丢包身份
`from . import x` 的 `.` 是「当前模块所属包的层级」，靠模块的包身份（由 `__name__` 推导出的 `__package__`）当锚点来定位。裸路径 `python mypkg/sub/mod.py` 把文件当独立脚本，`__name__` 设为无层级的 `"__main__"`，且不加载父包，锚点丢失 → 报 `ImportError`；而 `python -m mypkg.sub.mod` 逐级加载整条包链，`__name__` 保留点分全名，父包真实存在，锚点在位 → 相对导入正常。一句话：裸路径没给 `__name__` 层级也没建父包，锚点塌了；`-m` 保留了完整包身份。

实际例子：假设有这样一个包结构
```
mypkg/
├── __init__.py
└── sub/
    ├── __init__.py
    ├── mod.py        # 里面写：from . import helper
    └── helper.py
```
- 裸路径运行：`python mypkg/sub/mod.py`
  解释器只拿起 `mod.py` 一个文件，设 `__name__ == "__main__"`、不加载 `mypkg/` 和 `sub/`。执行到 `from . import helper` 时，`.` 需要「当前包」当锚点，但 `mod` 根本不知道自己属于 `mypkg.sub`，父包也不在内存里 → 报错 `ImportError: attempted relative import with no known parent package`。
- 模块名运行：`python -m mypkg.sub.mod`（在 `mypkg` 的上一级目录执行）
  解释器按 `sys.path` 找到 `mypkg` → 加载它、再加载 `mypkg.sub` → 最后加载 `mod`，`__name__ == "mypkg.sub.mod"`。`from . import helper` 的 `.` 锚定到 `mypkg.sub`，顺利找到同包的 `helper.py` → 正常运行。
对照：`mod.py` 这个文件**内容完全一样**，区别只在「怎么启动」——裸路径启动丢掉了包身份，`-m` 启动保留了包身份。
#### sys.path的查找顺序
入口脚本所在目录->PYTHONPATH->标准库目录->第三方包目录（site-packages）  
